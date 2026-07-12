// Square -> GitHub catalog sync. Stripe remains the payment provider; this script only
// mirrors Square catalog content and inventory into data/listings for the storefront.
// Node 20+ only, with no runtime dependencies.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API_VERSION = '2026-05-20';
const DEFAULT_DATA_DIR = 'data/listings';
const DEFAULT_SELLER = 'Square';
const DEFAULT_SOLD_STATUS = 'sold';
const VALID_LISTING_ID = /^lst_[a-z0-9]+$/;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function squareClient({ token, base, version }) {
  return async function square(path, init = {}) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Square-Version': version,
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Square ${path}: ${response.status} ${detail}`);
    }
    return response.json();
  };
}

export function stableListingId(squareVariationId) {
  const digest = createHash('sha256').update(squareVariationId).digest('hex').slice(0, 16);
  return `lst_sq${digest}`;
}

export function isPresentAtLocation(object, locationId) {
  if (!object || object.is_deleted) return false;
  if (object.present_at_all_locations === false) {
    return (object.present_at_location_ids || []).includes(locationId);
  }
  return !(object.absent_at_location_ids || []).includes(locationId);
}

function descriptionText(itemData) {
  if (typeof itemData.description === 'string' && itemData.description.trim()) {
    return itemData.description.trim().slice(0, 4000);
  }
  if (typeof itemData.description_html !== 'string') return '';
  return itemData.description_html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

function variationPrice(variationData, locationId) {
  const override = (variationData.location_overrides || []).find(
    (entry) => entry.location_id === locationId && entry.price_money,
  );
  const money = override?.price_money || variationData.price_money;
  const amount = Number(money?.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const currency = String(money.currency || '').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) return null;
  return { amount, currency };
}

function variationTitle(itemName, variationName, variationCount) {
  const name = String(itemName || 'Unnamed product').trim();
  const variant = String(variationName || '').trim();
  const includeVariation = variationCount > 1 || (variant && !/^regular$/i.test(variant));
  return (includeVariation ? `${name} - ${variant}` : name).slice(0, 140);
}

/** Convert Square ITEM/IMAGE objects plus inventory counts into storefront listings. */
export function buildSquareListings({
  objects,
  quantityByVariationId,
  locationId,
  existingBySquareId = new Map(),
  seller = DEFAULT_SELLER,
  soldOutStatus = DEFAULT_SOLD_STATUS,
  requireImage = false,
  requireTrackedInventory = false,
}) {
  const imageUrlById = new Map(
    objects
      .filter((object) => object.type === 'IMAGE' && object.image_data?.url)
      .map((object) => [object.id, object.image_data.url]),
  );
  const listings = [];

  for (const item of objects.filter((object) => object.type === 'ITEM')) {
    const itemData = item.item_data || {};
    if (!isPresentAtLocation(item, locationId) || itemData.is_archived) continue;

    const variations = (itemData.variations || []).filter(
      (variation) =>
        isPresentAtLocation(variation, locationId) &&
        variation.item_variation_data?.sellable !== false,
    );

    for (const variation of variations) {
      const variationData = variation.item_variation_data || {};
      const price = variationPrice(variationData, locationId);
      if (!variation.id || !price) continue;
      const tracksInventory = variationData.track_inventory === true;
      if (requireTrackedInventory && !tracksInventory) continue;

      const imageIds = [
        ...(variationData.image_ids || []),
        ...(itemData.image_ids || []),
      ];
      const images = [...new Set(imageIds.map((id) => imageUrlById.get(id)).filter(Boolean))].slice(0, 8);
      if (requireImage && images.length === 0) continue;

      const existing = existingBySquareId.get(variation.id);
      const quantity = tracksInventory
        ? Number(quantityByVariationId.get(variation.id) ?? 0)
        : undefined;
      const status = tracksInventory && quantity <= 0 ? soldOutStatus : 'active';
      const id = existing?.id && VALID_LISTING_ID.test(existing.id)
        ? existing.id
        : stableListingId(variation.id);

      listings.push({
        id,
        title: variationTitle(itemData.name, variationData.name, variations.length),
        description: descriptionText(itemData),
        priceCents: price.amount,
        currency: price.currency,
        images,
        seller,
        createdAt: existing?.createdAt || item.updated_at || new Date().toISOString(),
        status,
        ...(tracksInventory ? { quantity } : {}),
        squareId: variation.id,
        squareItemId: item.id,
      });
    }
  }
  return listings;
}

function loadListings(dataDir) {
  if (!existsSync(dataDir)) throw new Error(`data dir not found: ${dataDir}`);
  const rows = [];
  for (const filename of readdirSync(dataDir)) {
    if (!filename.endsWith('.json') || filename === 'index.json') continue;
    const path = join(dataDir, filename);
    try {
      const listing = JSON.parse(readFileSync(path, 'utf8'));
      if (listing && VALID_LISTING_ID.test(listing.id)) rows.push({ path, listing });
      else console.warn(`skip listing with invalid id: ${path}`);
    } catch (error) {
      console.warn(`skip unparseable ${path}: ${error.message}`);
    }
  }
  return rows;
}

async function fetchCatalog(square) {
  const objects = [];
  let cursor;
  do {
    const query = new URLSearchParams({ types: 'ITEM,IMAGE' });
    if (cursor) query.set('cursor', cursor);
    const response = await square(`/v2/catalog/list?${query}`);
    objects.push(...(response.objects || []));
    cursor = response.cursor;
  } while (cursor);
  return objects;
}

async function fetchInventory(square, variationIds, locationId) {
  const quantities = new Map();
  for (let offset = 0; offset < variationIds.length; offset += 1000) {
    const catalogObjectIds = variationIds.slice(offset, offset + 1000);
    let cursor;
    do {
      const body = {
        catalog_object_ids: catalogObjectIds,
        location_ids: [locationId],
        states: ['IN_STOCK'],
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      };
      const response = await square('/v2/inventory/counts/batch-retrieve', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      for (const count of response.counts || []) {
        quantities.set(count.catalog_object_id, Number(count.quantity || 0));
      }
      cursor = response.cursor;
    } while (cursor);
  }
  return quantities;
}

function comparable(listing) {
  return `${JSON.stringify(listing, null, 2)}\n`;
}

function writeListing(path, listing, dryRun) {
  const next = comparable(listing);
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (previous === next) return false;
  if (!dryRun) writeFileSync(path, next);
  return true;
}

export async function main() {
  const token = requiredEnv('SQUARE_ACCESS_TOKEN');
  const locationId = requiredEnv('SQUARE_LOCATION_ID');
  const base = process.env.SQUARE_API_BASE || 'https://connect.squareup.com';
  const version = process.env.SQUARE_VERSION || DEFAULT_API_VERSION;
  const dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR;
  const seller = process.env.SQUARE_SELLER_NAME || DEFAULT_SELLER;
  const soldOutStatus = process.env.SOLD_OUT_STATUS || DEFAULT_SOLD_STATUS;
  const requireImage = envBool('SQUARE_REQUIRE_IMAGE');
  const requireTrackedInventory = envBool('SQUARE_REQUIRE_TRACKED_INVENTORY');
  const hideUnmanaged = envBool('SQUARE_HIDE_UNMANAGED');
  const dryRun = envBool('DRY_RUN');
  const square = squareClient({ token, base, version });

  const rows = loadListings(dataDir);
  const existingBySquareId = new Map(
    rows.filter(({ listing }) => listing.squareId).map(({ listing }) => [listing.squareId, listing]),
  );
  const objects = await fetchCatalog(square);
  const variationIds = objects
    .filter((object) => object.type === 'ITEM')
    .flatMap((item) => item.item_data?.variations || [])
    .map((variation) => variation.id)
    .filter(Boolean);
  const quantityByVariationId = await fetchInventory(square, variationIds, locationId);
  const imported = buildSquareListings({
    objects,
    quantityByVariationId,
    locationId,
    existingBySquareId,
    seller,
    soldOutStatus,
    requireImage,
    requireTrackedInventory,
  });
  const importedSquareIds = new Set(imported.map((listing) => listing.squareId));
  const allById = new Map(rows.map(({ listing }) => [listing.id, listing]));
  let changed = 0;

  for (const listing of imported) {
    allById.set(listing.id, listing);
    const path = join(dataDir, `${listing.id}.json`);
    if (writeListing(path, listing, dryRun)) {
      changed++;
      console.log(`${dryRun ? 'would update' : 'updated'} ${listing.id}: ${listing.title}`);
    }
  }

  for (const { path, listing } of rows) {
    const staleSquareListing = listing.squareId && !importedSquareIds.has(listing.squareId);
    const unmanagedListing = !listing.squareId && hideUnmanaged;
    if ((staleSquareListing || unmanagedListing) && listing.status !== 'hidden') {
      const hidden = { ...listing, status: 'hidden' };
      allById.set(hidden.id, hidden);
      if (writeListing(path, hidden, dryRun)) {
        changed++;
        console.log(`${dryRun ? 'would hide' : 'hidden'} ${hidden.id}: ${hidden.title}`);
      }
    }
  }

  const index = [...allById.values()]
    .map((listing) => ({
      id: listing.id,
      title: listing.title,
      priceCents: listing.priceCents,
      currency: listing.currency,
      ...(listing.images?.[0] ? { image: listing.images[0] } : {}),
      status: listing.status,
    }))
    .sort((a, b) => {
      const byTitle = a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
      return byTitle || a.id.localeCompare(b.id);
    });
  const indexPath = join(dataDir, 'index.json');
  const indexChanged = writeListing(indexPath, index, dryRun);
  if (indexChanged) changed++;

  const active = imported.filter((listing) => listing.status === 'active').length;
  const sold = imported.filter((listing) => listing.status === soldOutStatus).length;
  console.log(
    `${dryRun ? 'dry run complete' : 'done'}: ${imported.length} Square listing(s), ` +
      `${active} active, ${sold} sold out, ${changed} file(s) ${dryRun ? 'would change' : 'changed'}.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
