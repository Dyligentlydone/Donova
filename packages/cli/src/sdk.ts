/**
 * Public SDK surface — re-exported as `@donova/cli/sdk` and mirrored by
 * the `@donova/sdk` package. Agents embed this instead of shelling out.
 */
export { initProject } from "./init.js";
export { checkProject, type CheckResult } from "./check.js";
export { probeCmd, timelineCmd } from "./inspect.js";
export { snapshotTimes, contactSheet } from "./snapshot.js";
export { transcribeCmd } from "./transcribe.js";
export { cutsCmd } from "./cuts.js";
export { scaffoldCmd } from "./scaffold.js";
export { captionsCmd } from "./captions.js";
export { addBlock } from "./add.js";
export { styleCmd, resolveStylePath, globalStylePath } from "./style.js";
export { doctor, type DoctorResult } from "./doctor.js";
export { CliError, ERR } from "./errors.js";
export type { Transcript, TranscriptWord, CutPlan, CutSegment } from "@donova/media";

// Headless composition-editing engine (Apache-2.0): find/patch/timing/history
// ops on our own composition files — the same API their Studio routes use.
export { openComposition } from "@hyperframes/sdk";
export type {
  SdkDocument,
  EditOp,
  ElementHandle,
  FindQuery,
  Composition,
} from "@hyperframes/sdk";

// Composition inspection: which HTML/CSS/GSAP source owns an element,
// animation schedules, live-preview probing — the agent's eyes before edits.
export { Inspector } from "@hyperframes/inspector";
