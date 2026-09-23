/**
 * Product view model and small typed accessors for approved properties.
 * Only approved presentations exist; properties are plain data validated
 * against each renderer's versioned property schema.
 */
import type { JsonValue } from "@ui-intelligence/protocol";

export type ProductView = {
  id: string;
  name: string;
  price: number;
  imageEmoji?: string;
};

/** Parse a data binding value into a list of product view models. */
export function parseProducts(value: JsonValue): ProductView[] {
  if (!Array.isArray(value)) return [];
  const products: ProductView[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const { id, name, price, imageEmoji } = item as Record<string, JsonValue>;
    if (typeof id !== "string" || typeof name !== "string" || typeof price !== "number") continue;
    products.push({
      id,
      name,
      price,
      ...(typeof imageEmoji === "string" ? { imageEmoji } : {}),
    });
  }
  return products;
}

export function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

export function numberProperty(properties: Record<string, JsonValue>, key: string, fallback: number): number {
  const value = properties[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function enumProperty<T extends string>(
  properties: Record<string, JsonValue>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = properties[key];
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function booleanProperty(properties: Record<string, JsonValue>, key: string, fallback: boolean): boolean {
  const value = properties[key];
  return typeof value === "boolean" ? value : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Six-product fixture used by tests, previews, and the reference app. */
export const sampleProducts: ProductView[] = [
  { id: "p_aurora", name: "Aurora Lamp", price: 89.0, imageEmoji: "🕯️" },
  { id: "p_basil", name: "Basil Planter", price: 24.5, imageEmoji: "🪴" },
  { id: "p_comet", name: "Comet Headphones", price: 149.99, imageEmoji: "🎧" },
  { id: "p_drift", name: "Drift Keyboard", price: 119.0, imageEmoji: "⌨️" },
  { id: "p_ember", name: "Ember Mug", price: 19.95, imageEmoji: "☕" },
  { id: "p_flint", name: "Flint Notebook", price: 9.5, imageEmoji: "📓" },
];
