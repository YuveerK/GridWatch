import sharp from "sharp";

export async function preprocessImage(input, { maxDimension = 2400 } = {}) {
  const base = sharp(input, { failOn: "none" }).rotate().resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: false });
  const grayscale = await base.clone().grayscale().normalize().png().toBuffer();
  const threshold = await base.clone().grayscale().normalize().threshold(165).png().toBuffer();
  return [{ variant: "grayscale", buffer: grayscale }, { variant: "threshold", buffer: threshold }];
}
