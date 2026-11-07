/**
 * Public SDK surface — re-exported as `@framecraft/cli/sdk` and mirrored by
 * the `@framecraft/sdk` package. Agents embed this instead of shelling out.
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
export type { Transcript, TranscriptWord, CutPlan, CutSegment } from "@framecraft/media";
