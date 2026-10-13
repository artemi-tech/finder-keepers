import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const source =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson";
const response = await fetch(source);
if (!response.ok) throw new Error(`Boundary download: ${response.status}`);
const raw = await response.text();
const countries = JSON.parse(raw).features;
const features = countries
  .filter(
    (f) =>
      f.properties.ADM0_A3 === "USA" ||
      f.properties.CONTINENT === "Europe" ||
      ["TUR", "CYP"].includes(f.properties.ADM0_A3),
  )
  .map((f) => ({
    name: f.properties.NAME_LONG,
    code: f.properties.ADM0_A3,
    region: f.properties.ADM0_A3 === "USA" ? "US" : "EU",
    polygons:
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates]
        : f.geometry.coordinates,
  }));
mkdirSync("lib/data", { recursive: true });
writeFileSync(
  "lib/data/land.json",
  JSON.stringify({
    version: 2,
    source,
    sha256: createHash("sha256").update(raw).digest("hex"),
    features,
  }),
);
console.log(`Saved ${features.length} country boundaries.`);
