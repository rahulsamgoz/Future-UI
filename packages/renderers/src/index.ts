/**
 * @ui-intelligence/renderers — approved presentations, page layouts, and
 * preview stubs (UI Intelligence R1, spec sections 7, 6, 18).
 */
export { ButtonRenderer, buttonRenderers } from "./buttonRenderers.js";
export {
  clamp,
  booleanProperty,
  enumProperty,
  formatPrice,
  numberProperty,
  parseProducts,
  sampleProducts,
  type ProductView,
} from "./products.js";
export {
  invokeAction,
  priceVisible,
  CarouselRenderer,
  GridRenderer,
  TableRenderer,
  productChooserRenderers,
} from "./productRenderers.js";
export {
  GridLayout,
  SplitLayout,
  StackLayout,
  pageLayoutRenderers,
  type LayoutNodeAsLayout,
  type LayoutNodeAsRegion,
} from "./pageLayouts.js";
export {
  createControlledDataProvider,
  createFixtureProductData,
  createSampleProductData,
  createStubActionBindings,
  nextInvocationId,
  type StubActionCall,
} from "./stubs.js";
export type { LayoutRendererProps, RendererEntry, RendererProps } from "./types.js";
export { registerAllRenderers, rendererComponents } from "./register.js";
