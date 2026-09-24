import { createContext, useContext } from "react";
import type { RuntimeKernel } from "@ui-intelligence/runtime-core";
import type { PreferenceService } from "./app/PreferenceService.js";
import type { LocalGenerator } from "./editor/LocalGenerator.js";
import type { Cart } from "./data/catalog.js";

export type AppServices = {
  kernel: RuntimeKernel;
  preferences: PreferenceService;
  generator: LocalGenerator;
  cart: Cart;
  apiBaseUrl: string | null;
};

export const ServicesContext = createContext<AppServices | null>(null);

export function useAppServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("ServicesContext provider missing");
  return services;
}
