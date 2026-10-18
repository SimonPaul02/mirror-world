// Order matters: this sets window.CESIUM_BASE_URL before Cesium is evaluated.
import "./cesium-base-url";
import "./style.css";

import { Cartesian3, Cartographic, JulianDate } from "cesium";

import { autopilot } from "./autopilot";
import { CameraRig } from "./camera";
import {
  CotFeed,
  bearingEvent,
  fixEvent,
  receiverEvent,
  toXml,
  truthEvent,
  type CotRecord,
} from "./cot";
import { Hud } from "./hud";
import { Controls } from "./input";
import { clamp, mulberry32, toDeg } from "./math";
import { MQ9_MODEL } from "./models";
import { MQ9 } from "./profiles";
import { RouteFollower } from "./route";
import {
  EMITTER,
  RECEIVERS,
  REPORT_INTERVAL_S,
  ROUTE,
  SCENARIO_ID,
  SCENARIO_NAME,
  SEED,
  START_ISO,
} from "./scenario";
import { ScenarioView } from "./scenario-view";
import { ScenarioCapture, validateScenario } from "./scenario-data";
import { SignalModel, crossBearings, type Detection, type Fix } from "./signals";
import { FlightSim } from "./sim";
import { Aircraft } from "./vehicle";
import { createScene, makeTerrainSampler } from "./viewer";

/** Floor and span of the manual altitude trim, metres. */
const MIN_AGL = 60;
const TRIM_LIMIT = 3000;

/** Re-publish the array positions this often so TAK never stales them out. */
const SITE_REFRESH_S = 120;

/** Simulated seconds per real second, cycled with T. */
const WARP_STEPS = [1, 5, 20, 60];
/** Keeps the flight integrator stable when time is compressed. */
const MAX_SIM_STEP = 0.05;

/** URL configuration keeps the scenario reproducible without editing source. */
const params = new URLSearchParams(window.location.search);
const integerParam = (name: string, fallback: number, min: number, max: number): number => {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};
const runSeed = integerParam("seed", SEED, 0, 2_147_483_647);
const reportIntervalS = integerParam("sample_s", REPORT_INTERVAL_S, 1, 60);
const runDurationS = integerParam("duration_s", 180, 120, 21_600);
const requestedRoute = params.get("route");
const routeVariant = requestedRoute === "south" || requestedRoute === "varied" ? requestedRoute : "full";
const routeRandom = mulberry32(runSeed ^ 0x5f3759df);
const scenarioRoute = routeVariant === "south"
  ? ROUTE.filter((point) => !["LYMAN", "DONETS", "SIVERSK"].includes(point.name))
  : routeVariant === "varied"
    ? ROUTE.map((point, index) => index === 0 || index === ROUTE.length - 1 ? point : {
      ...point,
      lon: point.lon + (routeRandom() - 0.5) * 0.02,
      lat: point.lat + (routeRandom() - 0.5) * 0.02,
      agl: Math.max(200, point.agl + (routeRandom() - 0.5) * 300),
    })
    : ROUTE;

const KEY_MAP: Array<[string, string]> = [
  ["F", "Follow / free camera"],
  ["W / S", "Forward / back (free)"],
  ["A / D", "Strafe (free)"],
  ["E / Q", "Up / down (free)"],
  ["Drag mouse", "Look / orbit"],
  ["Wheel", "Speed, or follow distance"],
  ["Shift", "Boost ×4"],
  ["G", "Face the aircraft"],
  ["[ / ]", "Trim route altitude"],
  ["T", "Time compression"],
  ["K", "Toggle the TAK feed"],
  ["Backspace", "Restart the scenario"],
  ["H", "Toggle this list"],
];

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

const row = (term: string, value: string): [HTMLElement, HTMLElement] => {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  return [dt, dd];
};

/** Hands the browser a file without a round trip to a server. */
function download(filename: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const stamp = (date: Date): string => date.toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function boot(): Promise<void> {
  const { viewer, hasRealTerrain, terrainId } = await createScene(el("cesium"));

  const sampleTerrain = makeTerrainSampler(viewer, () => hasRealTerrain);
  const sim = new FlightSim(MQ9, sampleTerrain);
  const aircraft = new Aircraft(viewer, sim, MQ9_MODEL);
  const controls = new Controls();
  const camera = new CameraRig(viewer, controls);
  const hud = new Hud();

  const route = new RouteFollower(scenarioRoute);
  const view = new ScenarioView(viewer, scenarioRoute, RECEIVERS);
  const feed = new CotFeed();
  // One seeded generator for the whole scenario: same seed, same sensor data.
  let signals = new SignalModel(RECEIVERS, EMITTER, sampleTerrain, mulberry32(runSeed), { samplePeriodS: reportIntervalS });
  const makeCapture = (): ScenarioCapture => new ScenarioCapture({
    scenarioId: `${SCENARIO_ID}-${routeVariant}-seed-${runSeed}`,
    startUtc: START_ISO,
    seed: runSeed,
    requestedDurationS: runDurationS,
    samplePeriodS: reportIntervalS,
    route: scenarioRoute,
    emitter: EMITTER,
    receivers: RECEIVERS,
    realTerrainAvailable: hasRealTerrain,
    terrainSource: hasRealTerrain ? terrainId : "flat ellipsoid fallback",
  });
  let capture = makeCapture();

  const scenarioStart = new Date(START_ISO);
  const startJulian = JulianDate.fromIso8601(START_ISO);

  let aglTrim = 0;
  let warpIndex = 0;
  let lastFrame = performance.now();

  // Report bookkeeping, all in scenario seconds since launch.
  let reportDue = 0;
  let sitesPublishedAt = Number.NEGATIVE_INFINITY;
  let previousFix: { fix: Fix; at: number } | undefined;
  let lastDetections: Detection[] = [];
  let lastFix: Fix | undefined;
  let lastMissM: number | undefined;

  // The scenario owns the clock, so the sun sits where the start time says.
  viewer.clock.startTime = startJulian.clone();
  viewer.clock.stopTime = JulianDate.addHours(startJulian, 3, new JulianDate());
  viewer.clock.currentTime = startJulian.clone();
  viewer.timeline?.zoomTo(viewer.clock.startTime, viewer.clock.stopTime);

  /** Parks the camera off the aircraft's left rear quarter, looking at it. */
  const viewpointBehind = (): Cartesian3 => {
    const carto = sim.state.carto;
    return Cartesian3.fromRadians(
      carto.longitude - 0.004,
      carto.latitude - 0.004,
      carto.height + 260,
    );
  };

  const launch = (): void => {
    const entry = scenarioRoute[0] as (typeof ROUTE)[number];
    route.reset();
    sim.spawn(entry.lon, entry.lat, route.launchBearingDeg(), entry.agl);
    aglTrim = 0;
    feed.clear();
    view.clear();
    signals = new SignalModel(RECEIVERS, EMITTER, sampleTerrain, mulberry32(runSeed), { samplePeriodS: reportIntervalS });
    capture = makeCapture();
    reportDue = 0;
    sitesPublishedAt = Number.NEGATIVE_INFINITY;
    previousFix = undefined;
    lastDetections = [];
    lastFix = undefined;
    lastMissM = undefined;
    aircraft.clearTrail();
    camera.placeLookingAt(viewpointBehind(), sim.state.position);
  };

  /** True once elevation is known under both arrays, so their masts are right. */
  const sitesReady = (): boolean =>
    RECEIVERS.every(
      (rx) => sampleTerrain(Cartographic.fromDegrees(rx.lon, rx.lat)) !== undefined,
    );

  const scenarioTime = (): Date =>
    new Date(scenarioStart.getTime() + sim.state.missionSeconds * 1000);

  /** One reporting interval: measure, cross, and write the CoT out. */
  const publishReport = (leg: string): void => {
    const now = scenarioTime();
    const records: CotRecord[] = [];

    if (sim.state.missionSeconds - sitesPublishedAt >= SITE_REFRESH_S) {
      sitesPublishedAt = sim.state.missionSeconds;
      for (const rx of RECEIVERS) {
        records.push(receiverEvent(rx, signals.antennaHae(rx), now));
      }
    }

    const detections = signals.observe(sim.state.carto);
    const fix = crossBearings(detections);
    const sequence = feed.nextSequence();
    capture.record({
      timestampS: sim.state.missionSeconds,
      drone: sim.state.carto,
      aglM: sim.state.aglHeight,
      detections,
    });

    for (const detection of detections) {
      if (detection.heard) records.push(bearingEvent(detection, EMITTER, sequence, now));
    }

    if (fix) {
      // Course and speed come from the previous fix, not from the truth —
      // it is what the arrays alone could work out.
      let courseDeg: number | undefined;
      let speedMs: number | undefined;
      if (previousFix && sim.state.missionSeconds - previousFix.at <= reportIntervalS * 4) {
        const span = sim.state.missionSeconds - previousFix.at;
        const from = Cartesian3.fromDegrees(previousFix.fix.lon, previousFix.fix.lat);
        const to = Cartesian3.fromDegrees(fix.lon, fix.lat);
        const travelled = Cartesian3.distance(from, to);
        if (span > 0) {
          speedMs = travelled / span;
          const dLon = (fix.lon - previousFix.fix.lon) * Math.cos((fix.lat * Math.PI) / 180);
          const dLat = fix.lat - previousFix.fix.lat;
          courseDeg = (toDeg(Math.atan2(dLon, dLat)) + 360) % 360;
        }
      }
      records.push(
        fixEvent(fix, detections, EMITTER, sequence, now, courseDeg, speedMs),
      );
      previousFix = { fix, at: sim.state.missionSeconds };
      lastMissM = Cartesian3.distance(
        Cartesian3.fromDegrees(fix.lon, fix.lat, fix.haeM),
        sim.state.position,
      );
    } else {
      lastMissM = undefined;
    }

    records.push(
      truthEvent(
        EMITTER,
        toDeg(sim.state.carto.latitude),
        toDeg(sim.state.carto.longitude),
        sim.state.carto.height,
        sim.state.aglHeight,
        toDeg(sim.state.bearing),
        sim.state.forwardSpeed,
        leg,
        now,
      ),
    );

    feed.push(...records);
    view.setReports(detections, fix, sim.state.position);
    lastDetections = detections;
    lastFix = fix;
  };

  // ---------- panels ----------

  const feedXml = el<HTMLPreElement>("cot-xml");
  const feedCount = el("cot-count");
  const feedState = el("cot-state");

  const refreshFeedPanel = (): void => {
    const shown =
      feed.latestWhere((r) => r.uid.startsWith("sig-")) ??
      feed.latestWhere((r) => r.channel === "sensor") ??
      feed.latest();
    feedXml.textContent = shown ? toXml(shown) : "waiting for the first report…";
    feedCount.textContent = `${feed.size} events · ${feed.count("sensor")} sensor · ${feed.count("truth")} truth`;

    const heard = lastDetections.filter((d) => d.heard).map((d) => d.receiver.uid);
    if (lastFix) {
      feedState.textContent = `FIX from ${lastFix.contributors.join("+")}`;
      feedState.className = "badge";
    } else if (heard.length === 1) {
      feedState.textContent = `BEARING ONLY · ${heard[0]}`;
      feedState.className = "badge badge--free";
    } else {
      feedState.textContent = "NO DETECTION";
      feedState.className = "warn";
    }
  };

  const refreshMissionPanel = (leg: string, distanceM: number, lap: number): void => {
    const rf = RECEIVERS.map((rx) => {
      const detection = lastDetections.find((d) => d.receiver.uid === rx.uid);
      if (!detection) return row(rx.uid, "—");
      return row(
        rx.uid,
        detection.heard
          ? `${detection.rssiDbm.toFixed(1)} dBm · ${(detection.groundRangeM / 1000).toFixed(1)} km`
          : detection.terrainComplete ? `below threshold (terrain loss ${detection.terrainLossDb.toFixed(0)} dB)` : "terrain data pending",
      );
    });

    el("mission-list").replaceChildren(
      ...[
        row("Scenario", `${scenarioTime().toISOString().slice(11, 19)}Z`),
        row("Leg", leg),
        row("To run", `${(distanceM / 1000).toFixed(1)} km`),
        row("Lap", String(lap + 1)),
        ...rf,
        row(
          "Fix error",
          lastMissM === undefined ? "no fix" : `${Math.round(lastMissM)} m`,
        ),
        row("ce 1σ", lastFix ? `${Math.round(lastFix.ceM)} m` : "—"),
      ].flat(),
    );
  };

  /** Everything a reader needs to interpret the capture. */
  const manifest = (): string =>
    JSON.stringify(
      {
        scenario: SCENARIO_ID,
        name: SCENARIO_NAME,
        region: "Donetsk Oblast, Ukraine (Donbas)",
        start_utc: START_ISO,
        generated_utc: new Date().toISOString(),
        elapsed_s: Math.round(sim.state.missionSeconds),
        seed: runSeed,
        report_interval_s: reportIntervalS,
        requested_duration_s: runDurationS,
        note:
          "Every record carries a _mirrorworld element naming the scenario object " +
          "it came from and whether it is truth (truth=\"1\") or sensor derived.",
        objects: {
          [EMITTER.uid]: {
            kind: "uav",
            platform: `${MQ9.spec.designation} ${MQ9.spec.name}`,
            emitter: {
              freq_mhz: EMITTER.freqMhz,
              eirp_dbm: EMITTER.eirpDbm,
              bandwidth_mhz: EMITTER.bandwidthMhz,
              description: "Analogue video downlink, always keyed",
            },
            cot_type_truth: "a-h-A-M-F-Q",
          },
          ...Object.fromEntries(
            RECEIVERS.map((rx) => [
              rx.uid,
              {
                kind: "df-array",
                callsign: rx.callsign,
                lon: rx.lon,
                lat: rx.lat,
                mast_m: rx.mastM,
                antenna_hae_m: Number(signals.antennaHae(rx).toFixed(1)),
                gain_dbi: rx.gainDbi,
                noise_floor_dbm: rx.noiseFloorDbm,
                detect_snr_db: rx.detectSnrDb,
                sigma_floor_deg: rx.sigmaFloorDeg,
                bias_deg: rx.biasDeg,
                cot_type: "a-f-G-E-S",
              },
            ]),
          ),
        },
        propagation: {
          model: "Free-space path loss + ITU-R P.526 single knife-edge diffraction",
          effective_earth_factor: 1.333,
          clutter_allowance_m: 6,
          shadowing: "Log-normal, 2.6 dB sigma, first-order correlated in time",
          terrain: hasRealTerrain
            ? `${terrainId} terrain provider, sampled 40 points per path when tiles are available`
            : "Ellipsoid — no terrain loaded, so no masking",
        },
        geolocation: {
          method: "Crossed bearings from the two strongest arrays",
          minimum_cross_angle_deg: 8,
          ce_definition: "1 sigma, metres, from range × bearing sigma over the crossing angle",
          altitude: "From the nearer array's elevation channel; le grows with range",
        },
        route: scenarioRoute,
      },
      null,
      2,
    );

  const feedHeader = (): string[] => [
    `Mirror World — ${SCENARIO_NAME}`,
    `Scenario ${SCENARIO_ID}, seed ${runSeed}, start ${START_ISO}`,
    `Donetsk Oblast, Ukraine. ${Math.round(sim.state.missionSeconds)} s of scenario time.`,
    `Emitter ${EMITTER.uid} at ${EMITTER.freqMhz} MHz, ${EMITTER.eirpDbm} dBm EIRP.`,
    `Arrays ${RECEIVERS.map((r) => r.uid).join(", ")}.`,
    `Each <event> is one CoT record. truth="1" marks the answer key; everything`,
    `else is what the arrays reported. A live TAK link sends these one at a time;`,
    `the <events> wrapper only makes the capture a single well-formed document.`,
  ];

  (window as any).__dbg = { controls, camera, viewer, sim, feed, route, signals };
  hud.setSpec(MQ9);
  hud.setKeyMap(KEY_MAP);
  hud.setWarp(WARP_STEPS[warpIndex] as number);
  el("scenario-name").textContent = SCENARIO_NAME;
  launch();
  hud.setCameraMode(camera.current);
  refreshFeedPanel();

  controls.on("focus", () => camera.aimAt(sim.state.position));
  controls.on("toggleFollow", () => {
    camera.toggleMode();
    hud.setCameraMode(camera.current);
  });
  controls.on("reset", () => {
    launch();
    hud.setCameraMode(camera.current);
    refreshFeedPanel();
  });
  controls.on("toggleHelp", () => hud.toggleHelp());
  controls.on("toggleFeed", () => el("cot").classList.toggle("card--collapsed"));
  controls.on("timeWarp", () => {
    warpIndex = (warpIndex + 1) % WARP_STEPS.length;
    hud.setWarp(WARP_STEPS[warpIndex] as number);
  });

  el("help-toggle").addEventListener("click", () => hud.toggleHelp());
  el("spec-toggle").addEventListener("click", () => hud.toggleSpec());
  el("cot-toggle").addEventListener("click", () => el("cot").classList.toggle("card--collapsed"));
  el("cot-download").addEventListener("click", () => {
    download(
      `${SCENARIO_ID}-${stamp(scenarioTime())}.cot`,
      "application/xml",
      feed.toDocument(feedHeader()),
    );
  });
  el("cot-manifest").addEventListener("click", () => {
    download(`${SCENARIO_ID}-manifest.json`, "application/json", manifest());
  });
  el("scenario-download").addEventListener("click", () => {
    const data = capture.snapshot();
    const issues = validateScenario(data);
    el("scenario-export-status").textContent = issues.length
      ? `Exported with ${issues.length} validation warning(s): ${issues.join(" ")}`
      : `Scenario export valid: ${data.ground_truth.length} frames, ${data.observations.length} RF observations.`;
    download(`${data.scenario_id}.json`, "application/json", JSON.stringify(data, null, 2));
  });

  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    // Clamp dt so a backgrounded tab doesn't teleport the aircraft on return.
    const dt = clamp((now - lastFrame) / 1000, 0, 0.1);
    lastFrame = now;
    if (dt <= 0) return;

    const command = route.update(sim.state);

    // [ and ] trim the route's altitude without rewriting the plan.
    const axes = controls.axes();
    if (axes.bracket !== 0) {
      aglTrim = clamp(
        aglTrim + axes.bracket * 400 * dt * (axes.boost ? 6 : 1),
        -TRIM_LIMIT,
        TRIM_LIMIT,
      );
    }
    const commandedAgl = clamp(
      command.agl + aglTrim,
      MIN_AGL,
      MQ9.spec.serviceCeiling - sim.state.groundHeight,
    );

    // Compressed time is stepped in small slices so the integrator stays stable.
    const warp = WARP_STEPS[warpIndex] as number;
    let remaining = dt * warp;
    let guard = 0;
    while (remaining > 1e-4 && guard < 40) {
      const step = Math.min(remaining, MAX_SIM_STEP);
      sim.update(step, autopilot(sim.state, commandedAgl, command.bearing));
      remaining -= step;
      guard += 1;
    }
    aircraft.recordTrail(dt * warp);

    const leg = `${command.from.name} → ${command.to.name}`;
    if (sim.state.missionSeconds >= reportDue && reportDue < runDurationS && sitesReady()) {
      // One report per interval even under time compression, so the feed's
      // timestamps stay evenly spaced however fast the scenario is played.
      publishReport(leg);
      reportDue =
        Math.floor(sim.state.missionSeconds / reportIntervalS + 1) * reportIntervalS;
      refreshFeedPanel();
    }
    refreshMissionPanel(leg, command.distanceM, command.lap);

    viewer.clock.currentTime = JulianDate.addSeconds(
      startJulian,
      sim.state.missionSeconds,
      viewer.clock.currentTime,
    );

    // The camera always runs on real time, never compressed.
    camera.update(dt, sim.state.position, sim.state.bearing);
    hud.update(
      sim.state,
      sim.enduranceRemainingHours(),
      camera.heightAboveGround(),
      camera.moveSpeed(),
      dt,
    );
  });

  if (!hasRealTerrain) console.info("[mirror-world] running on ellipsoid terrain.");

  // Hold the boot overlay until the globe has something worth showing. The
  // queue never reaches zero while the aircraft is moving, so wait for it to
  // drain to a nearly-complete base instead.
  const bootOverlay = el("boot");
  const bootText = bootOverlay.querySelector(".boot__text") as HTMLElement | null;
  let booted = false;
  const finishBoot = (): void => {
    if (booted) return;
    booted = true;
    bootOverlay.classList.add("boot--done");
    window.setTimeout(() => bootOverlay.remove(), 500);
  };

  const stopWatching = viewer.scene.globe.tileLoadProgressEvent.addEventListener(
    (queued: number) => {
      if (booted) return;
      if (bootText && queued > 0) {
        bootText.textContent = `Streaming terrain — ${queued} tiles left`;
      }
      if (queued <= 6) {
        stopWatching();
        finishBoot();
      }
    },
  );
  window.setTimeout(finishBoot, 6_000);
}

boot().catch((error: unknown) => {
  console.error(error);
  const overlay = document.getElementById("boot");
  if (overlay) overlay.innerHTML = `<p class="boot__text">Failed to start: ${String(error)}</p>`;
});
