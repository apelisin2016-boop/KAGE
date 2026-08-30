const PATHS = [
  "units/leaf",
  "units/sand",
  "units/mist",
  "units/cloud",
  "units/stone",
  "units/missing",
  "units/genin",
  "units/chunin",
  "units/illusion",
  "units/cavalry",
  "units/siege",
  "units/anbu",
  "commanders/leaf",
  "commanders/sand",
  "commanders/mist",
  "commanders/cloud",
  "commanders/stone",
  "bases/leaf",
  "bases/sand",
  "bases/mist",
  "bases/cloud",
  "bases/stone",
  "bases/settlement",
  "buildings/academy",
  "buildings/market",
  "buildings/wall",
  "buildings/temple",
  "buildings/hospital",
  "buildings/tower",
  "icons/genin",
  "icons/chunin",
  "icons/illusion",
  "icons/cavalry",
  "icons/siege",
  "icons/anbu",
  "terrain/plains",
  "terrain/forest",
  "terrain/hill",
  "terrain/mountain",
  "terrain/desert",
  "terrain/river",
  "terrain/scorched",
  "terrain/trees",
  "terrain/peak",
  "props/ryo",
  "props/supplies",
  "props/chakra",
  "props/scroll",
  "props/shrine",
  "props/cache",
  "props/bounty",
];

const cache = new Map<string, HTMLImageElement>();
let loaded = false;
let loading: Promise<void> | null = null;

export function spritesReady() {
  return loaded;
}

export function loadSprites(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = Promise.all(
    PATHS.map(
      (key) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            cache.set(key, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = `/sprites/${key}.png`;
        }),
    ),
  ).then(() => {
    loaded = true;
  });
  return loading;
}

export function spr(key: string): HTMLImageElement | null {
  return cache.get(key) ?? null;
}

export function drawSpr(
  ctx: CanvasRenderingContext2D,
  key: string,
  x: number,
  y: number,
  h: number,
  opts?: { anchor?: "feet" | "center"; alpha?: number },
): boolean {
  const im = cache.get(key);
  if (!im || !im.naturalWidth) return false;
  const w = (im.naturalWidth / im.naturalHeight) * h;
  const ax = x - w / 2;
  const ay = (opts?.anchor ?? "feet") === "center" ? y - h / 2 : y - h;
  const prev = ctx.globalAlpha;
  if (opts?.alpha !== undefined) ctx.globalAlpha = opts.alpha * prev;
  ctx.drawImage(im, ax, ay, w, h);
  ctx.globalAlpha = prev;
  return true;
}

export function stackArt(opts: {
  village?: string | null;
  commander?: boolean;
  missing?: boolean;
  unit?: string | null;
}): string {
  if (opts.missing) return "units/missing";
  if (opts.commander && opts.village) return `commanders/${opts.village}`;
  if (opts.unit) return `units/${opts.unit}`;
  if (opts.village) return `units/${opts.village}`;
  return "units/missing";
}
