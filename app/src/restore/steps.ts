// The restore pipeline vocabulary: a photo goes through an ordered list of
// steps, each blended (0..1) against its own input. This mirrors
// tools/restore/engine.py `step_key`; field names must match exactly.

export type ResizeMethod = "lanczos" | "area" | "cubic" | "linear" | "nearest";

/** A print's four corners, TL TR BR BL, as fractions of the photo's width and height. */
export type Quad = [[number, number], [number, number], [number, number], [number, number]];

/** A quad inset 10% from the edges: the starting point for placing corners by hand. */
export const DEFAULT_QUAD: Quad = [
  [0.1, 0.1],
  [0.9, 0.1],
  [0.9, 0.9],
  [0.1, 0.9],
];

export type Step =
  | { type: "model"; model: string; tile: number; w: number; face: boolean; blend: number }
  | { type: "pmrf"; steps: number; seed: number; mmse: boolean; blend: number }
  | { type: "bopbtl"; scratch: boolean; hr: boolean; faces: boolean; blend: number }
  | { type: "resize"; scale: number; method: ResizeMethod; blend: number }
  | { type: "sharpen"; amount: number; radius: number; blend: number }
  | { type: "grain"; amount: number; size: number; seed: number; blend: number }
  | { type: "cmd"; cmd: string; blend: number }
  /** Straighten and crop a photographed print (tools/autocrop). `quad` null =
   * detect automatically; `rotate` is quarter turns clockwise. Blend is always 1. */
  | { type: "autocrop"; quad: Quad | null; inset: number; rotate: 0 | 1 | 2 | 3; blend: 1 };

export type StepType = Step["type"];

export const STEP_TYPES: StepType[] = ["autocrop", "model", "pmrf", "bopbtl", "resize", "sharpen", "grain", "cmd"];

/** Human names for the step picker. */
export const STEP_NAMES: Record<StepType, string> = {
  autocrop: "Crop a photographed print",
  model: "Model (denoise, deblur, faces…)",
  pmrf: "Faces: PMRF",
  bopbtl: "Old print: Bringing Old Photos Back to Life",
  resize: "Resize",
  sharpen: "Sharpen",
  grain: "Add grain",
  cmd: "Shell command",
};

export function defaultStep(type: StepType, model = ""): Step {
  switch (type) {
    case "model":
      return { type, model, tile: 512, w: 0.5, face: false, blend: 1 };
    case "pmrf":
      return { type, steps: 25, seed: 0, mmse: false, blend: 1 };
    case "bopbtl":
      return { type, scratch: false, hr: false, faces: false, blend: 1 };
    case "resize":
      return { type, scale: 0.5, method: "lanczos", blend: 1 };
    case "sharpen":
      return { type, amount: 0.5, radius: 1.0, blend: 1 };
    case "grain":
      return { type, amount: 0.03, size: 1.0, seed: 0, blend: 1 };
    case "cmd":
      return { type, cmd: "/path/to/venv/bin/python /path/to/script.py --input {in} --output {out}", blend: 1 };
    case "autocrop":
      return { type, quad: null, inset: 0, rotate: 0, blend: 1 };
  }
}

const modelStem = (m: string) => m.replace(/^.*[/\\]/, "").replace(/\.(pth|safetensors|pt|ckpt)$/i, "");

/** Short label for a step in a list. */
export function stepLabel(s: Step): string {
  const b = s.blend < 1 ? ` · ${Math.round(s.blend * 100)}%` : "";
  switch (s.type) {
    case "model":
      return (
        (modelStem(s.model) || "model?") +
        (s.face ? " · faces" : "") +
        (/codeformer/i.test(s.model) ? ` · w ${s.w}` : "") +
        b
      );
    case "pmrf":
      return (s.mmse ? "PMRF posterior mean" : `PMRF ${s.steps} steps${s.seed ? ` #${s.seed}` : ""}`) + b;
    case "bopbtl":
      return "Old Photos" + (s.faces ? " + faces" : "") + (s.scratch ? " + scratches" : "") + (s.hr ? " (HR)" : "") + b;
    case "resize":
      return `Resize ×${s.scale}` + b;
    case "sharpen":
      return `Sharpen ${s.amount} / ${s.radius}` + b;
    case "grain":
      return `Grain ${s.amount}` + b;
    case "cmd":
      return "Command: " + (s.cmd.trim().split(/\s+/).pop() ?? "").slice(0, 24) + b;
    case "autocrop":
      return "Crop print" + (s.quad ? " (corners set)" : " (auto)") + (s.rotate ? ` · ${s.rotate * 90}°` : "") + (s.inset ? ` · inset ${Math.round(s.inset * 100)}%` : "");
  }
}

// ---- presets ---------------------------------------------------------------

export interface Preset {
  name: string;
  steps: Step[];
  builtin: boolean;
}

const pmrf = (blend = 1): Step => ({ type: "pmrf", steps: 25, seed: 0, mmse: false, blend });
const oldPhotos = (scratch: boolean): Step => ({ type: "bopbtl", scratch, hr: scratch, faces: false, blend: 1 });

const cropPrint = (): Step => ({ type: "autocrop", quad: null, inset: 0, rotate: 0, blend: 1 });

export const BUILTIN_PRESETS: Preset[] = [
  { name: "Crop a scanned print", steps: [cropPrint()], builtin: true },
  { name: "Crop print + clean up", steps: [cropPrint(), oldPhotos(false)], builtin: true },
  { name: "Crop print + clean up + faces", steps: [cropPrint(), oldPhotos(false), pmrf()], builtin: true },
  { name: "Faces (PMRF)", steps: [pmrf()], builtin: true },
  { name: "Faces, gentle (PMRF 60%)", steps: [pmrf(0.6)], builtin: true },
  { name: "Old print: clean up", steps: [oldPhotos(false)], builtin: true },
  { name: "Old print: clean up + scratches", steps: [oldPhotos(true)], builtin: true },
  { name: "Old print + faces", steps: [oldPhotos(false), pmrf()], builtin: true },
  { name: "Old print + scratches + faces", steps: [oldPhotos(true), pmrf()], builtin: true },
  {
    name: "Faces, gentle (GFPGAN 35%)",
    steps: [{ type: "model", model: "GFPGANv1.4.pth", tile: 512, w: 0.5, face: false, blend: 0.35 }],
    builtin: true,
  },
  {
    name: "Denoise (SCUNet)",
    steps: [{ type: "model", model: "scunet_color_real_psnr.pth", tile: 512, w: 0.5, face: false, blend: 1 }],
    builtin: true,
  },
  {
    name: "Deblur (Restormer, motion)",
    steps: [{ type: "model", model: "restormer_motion_deblurring.pth", tile: 512, w: 0.5, face: false, blend: 1 }],
    builtin: true,
  },
];

const USER_PRESETS_KEY = "restore-presets";

// ---- validation: anything from storage or a file is `unknown` -------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const METHODS: ResizeMethod[] = ["lanczos", "area", "cubic", "linear", "nearest"];

const pair = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number"
    ? [Math.max(-0.5, Math.min(1.5, v[0])), Math.max(-0.5, Math.min(1.5, v[1]))]
    : null;

/** Four corner pairs, or null (auto-detect) for anything else. */
export function parseQuad(v: unknown): Quad | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const pts = v.map(pair);
  return pts.every((p): p is [number, number] => p !== null) ? [pts[0], pts[1], pts[2], pts[3]] : null;
}

/** Coerce one stored step into the current shape, or null when the type is unknown. */
export function parseStep(v: unknown): Step | null {
  if (!isRecord(v) || typeof v.type !== "string") return null;
  const type = v.type;
  if (!(STEP_TYPES as string[]).includes(type)) return null;
  const d = defaultStep(type as StepType);
  const blend = Math.max(0, Math.min(1, num(v.blend, 1)));
  switch (d.type) {
    case "model":
      return { type: "model", model: str(v.model, ""), tile: num(v.tile, d.tile), w: num(v.w, d.w), face: bool(v.face, d.face), blend };
    case "pmrf":
      return { type: "pmrf", steps: Math.max(1, Math.round(num(v.steps, d.steps))), seed: Math.round(num(v.seed, d.seed)), mmse: bool(v.mmse, d.mmse), blend };
    case "bopbtl":
      return { type: "bopbtl", scratch: bool(v.scratch, d.scratch), hr: bool(v.hr, d.hr), faces: bool(v.faces, d.faces), blend };
    case "resize": {
      const m = str(v.method, d.method);
      return { type: "resize", scale: num(v.scale, d.scale), method: METHODS.includes(m as ResizeMethod) ? (m as ResizeMethod) : d.method, blend };
    }
    case "sharpen":
      return { type: "sharpen", amount: num(v.amount, d.amount), radius: num(v.radius, d.radius), blend };
    case "grain":
      return { type: "grain", amount: num(v.amount, d.amount), size: num(v.size, d.size), seed: Math.round(num(v.seed, d.seed)), blend };
    case "cmd":
      return { type: "cmd", cmd: str(v.cmd, d.cmd), blend };
    case "autocrop": {
      const r = Math.round(num(v.rotate, 0)) % 4;
      return {
        type: "autocrop",
        quad: parseQuad(v.quad),
        inset: Math.max(0, Math.min(0.2, num(v.inset, 0))),
        rotate: r === 1 || r === 2 || r === 3 ? r : 0,
        blend: 1,
      };
    }
  }
}

export function parseSteps(v: unknown): Step[] {
  if (!Array.isArray(v)) return [];
  return v.map(parseStep).filter((s): s is Step => s !== null);
}

export function loadUserPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecord)
      .filter((p) => typeof p.name === "string")
      .map((p) => ({ name: p.name as string, steps: parseSteps(p.steps), builtin: false }))
      .filter((p) => p.steps.length > 0);
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: Preset[]): void {
  try {
    localStorage.setItem(
      USER_PRESETS_KEY,
      JSON.stringify(presets.filter((p) => !p.builtin).map((p) => ({ name: p.name, steps: p.steps }))),
    );
  } catch {
    // storage unavailable: presets live for the session only
  }
}

export const allPresets = (user: Preset[]): Preset[] => [...BUILTIN_PRESETS, ...user];

/** Which optional engines a pipeline needs, for gating against the server's capabilities. */
export function needs(steps: Step[]): { pmrf: boolean; bopbtl: boolean } {
  return {
    pmrf: steps.some((s) => s.type === "pmrf"),
    bopbtl: steps.some((s) => s.type === "bopbtl"),
  };
}
