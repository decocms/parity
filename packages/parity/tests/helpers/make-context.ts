import type { CheckContext } from "../../src/checks/index.ts";
import type {
  FlowCapture,
  PageCapture,
  ParityIgnore,
  ParityRc,
  Viewport,
} from "../../src/types/schema.ts";

const DEFAULT_RC: ParityRc = {
  cep: "01310-100",
  selectors: {},
  skipSteps: [],
};

const DEFAULT_IGNORE: ParityIgnore = {
  ignoreSelectorsVisual: [],
  ignoreRequestPatterns: [],
  ignoreConsolePatterns: [],
  ignoreMetaKeys: [],
  toleratedDomDrift: {},
};

export function makeContext(
  over: {
    prodPages?: PageCapture[];
    candPages?: PageCapture[];
    prodFlows?: FlowCapture[];
    candFlows?: FlowCapture[];
    rc?: Partial<ParityRc>;
    ignore?: Partial<ParityIgnore>;
    viewports?: Viewport[];
    outDir?: string;
    cacheDir?: string;
    noCache?: boolean;
  } = {},
): CheckContext {
  return {
    prodPages: over.prodPages ?? [],
    candPages: over.candPages ?? [],
    prodFlows: over.prodFlows ?? [],
    candFlows: over.candFlows ?? [],
    rc: {
      ...DEFAULT_RC,
      ...over.rc,
      selectors: { ...DEFAULT_RC.selectors, ...over.rc?.selectors },
    },
    ignore: { ...DEFAULT_IGNORE, ...over.ignore },
    outDir: over.outDir ?? "/tmp/parity-test",
    cacheDir: over.cacheDir,
    noCache: over.noCache,
    viewports: over.viewports ?? ["mobile"],
  };
}
