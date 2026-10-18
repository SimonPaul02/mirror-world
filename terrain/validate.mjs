// Checks packaged assets and input; does not generate a flight.
import { loadScenario } from "./engine/config.mjs";
try {
  const { input, manifest } = await loadScenario(process.argv[2]);
  console.log(JSON.stringify({
    status: "pass", terrain_id: manifest.terrain_id,
    asset_checksums: "verified", input_contract: "valid",
    expected_sample_count: Math.ceil(input.simulation.duration_s / input.simulation.output_interval_s),
    trajectory_generated: false, browser_connected: manifest.integration.runtime_connected,
    limitations: [
      "This command verifies asset hashes and configuration; run trajectory:generate to validate a path.",
      "Zero elevation does not establish water or valid-data classification.",
      "Vertical reference comes from provider documentation; HAE conversion is not supplied."
    ]
  }, null, 2));
} catch (error) {
  console.error(`Terrain validation failed: ${error.message}`);
  process.exitCode = 1;
}
