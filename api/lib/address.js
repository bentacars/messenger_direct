import { fetchInventory } from './inventory.js';

export async function resolveAddressByChosen(session) {
  const sku = session?.chosen?.sku;
  if (!sku) return null;
  const inv = await fetchInventory();
  const unit = inv.find(u => String(u.SKU || u.sku || '') === String(sku));
  return unit?.complete_address || null;
}
