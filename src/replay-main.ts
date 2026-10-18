import './cesium-base-url';
import './replay.css';
import { Viewer, TileMapServiceImageryProvider, SingleTileImageryProvider, UrlTemplateImageryProvider,
  buildModuleUrl, Cartesian3, Color, Rectangle, Math as CMath, CallbackPositionProperty,
  CallbackProperty, HeadingPitchRoll, Transforms, JulianDate, ClockRange, HeadingPitchRange,
  PolylineGlowMaterialProperty, Cartesian2, LabelStyle, VerticalOrigin, Matrix4, ConstantProperty } from 'cesium';
import { fromArrayBuffer } from 'geotiff';
import { LocalTerrainProvider } from './local-terrain';
import { sampleGrid, replayState, type Grid, type TruthState } from './replay-math';
import { MQ9_MODEL } from './models';
import { generateRfScenario, type SensorGeneratorConfig } from './sensor-generator';
import { ScenarioView } from './scenario-view';
import { EstimateTrail } from './estimate-trail';
import odesaRfConfig from '../examples/rf_sensor_odesa.json';

/** The movement block of a generator config; vertical fields exist per mode. */
interface Movement {
  altitude_mode: 'constant_egm2008_height' | 'smooth_random_agl';
  max_climb_rate_mps?: number;
  altitude_change_interval_s?: number;
  height_band_m?: [number, number];
  height_step_m?: number;
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const asset = (name: string) => `${import.meta.env.BASE_URL}trajectory/${name}`;
async function get(name: string) {
  const response = await fetch(asset(name));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response;
}
async function main() {
  const [manifest, defaults, geoidBytes, demBytes, shadeBytes] = await Promise.all([
    get('manifest.json').then(r => r.json()), get('defaults.json').then(r => r.json()),
    get('geoid-egm2008.json').then(r => r.arrayBuffer()),
    get('elevation.tif').then(r => r.arrayBuffer()), get('hillshade.tif').then(r => r.arrayBuffer())
  ]);
  const hash = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  if (await hash(demBytes) !== manifest.assets.surface_elevation.sha256 || await hash(geoidBytes) !== manifest.assets.geoid_undulation.sha256) throw new Error('RF terrain/geoid checksum mismatch');
  const geoid = JSON.parse(new TextDecoder().decode(geoidBytes)) as Grid;
  const dem = await (await fromArrayBuffer(demBytes)).getImage();
  const surface: Grid = { width: dem.getWidth(), height: dem.getHeight(),
    west: dem.getOrigin()[0]!, north: dem.getOrigin()[1]!, dx: dem.getResolution()[0]!, dy: -dem.getResolution()[1]!,
    values: await dem.readRasters({samples:[0], interleave:true}) as Float32Array };
  if (manifest.coordinates.vertical_crs !== 'EPSG:3855') throw new Error('Replay requires EGM2008 truth heights');
  let states: TruthState[] = [];
  let duration: number = defaults.simulation.duration_s;
  let start = JulianDate.fromIso8601(defaults.simulation.start_time);
  let end = JulianDate.addSeconds(start, duration, new JulianDate());
  const base = await TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII'));
  const viewer = new Viewer('cesium', { baseLayer: false,
    terrainProvider: new LocalTerrainProvider(surface, geoid, manifest.attribution, 4),
    animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,
    sceneModePicker:false,navigationHelpButton:false,fullscreenButton:false,
    selectionIndicator:false,infoBox:false,shouldAnimate:false });
  viewer.imageryLayers.addImageryProvider(base);
  viewer.scene.globe.baseColor = Color.fromCssColorString('#1b3445');
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.enableLighting = false;
  const shade = await (await fromArrayBuffer(shadeBytes)).getImage();
  const shadeValues = await shade.readRasters({samples:[0],interleave:true}) as Uint8Array;
  const canvas = document.createElement('canvas'); canvas.width = shade.getWidth(); canvas.height = shade.getHeight();
  const ctx = canvas.getContext('2d')!; const pixels = ctx.createImageData(canvas.width,canvas.height);
  for (let i=0; i<shadeValues.length; i++) {
    const v = shadeValues[i]!; const k=i*4;
    pixels.data[k]=v*.70; pixels.data[k+1]=v*.84; pixels.data[k+2]=v*.81;
    pixels.data[k+3]=v === 0 ? 0 : 255;
  }
  ctx.putImageData(pixels,0,0);
  const [w,s,e,n] = manifest.grid.pixel_edge_bounds_wsen;

  // The Copernicus tile holds 96 m of relief spread over 44 km — a 0.2% slope.
  // Rendered at true scale from any useful viewing distance that is a flat
  // plane, which is why the scene reads as a 2D map even though it is real
  // terrain. Heights are orthometric (EGM2008), so scaling them before the
  // geoid is added exaggerates about mean sea level. LocalTerrainProvider
  // applies exactly the same factor to the ground.
  let exaggeration = 4;
  const localShade = viewer.imageryLayers.addImageryProvider(await SingleTileImageryProvider.fromUrl(
    canvas.toDataURL(), {rectangle:Rectangle.fromDegrees(w,s,e,n), credit:manifest.attribution}));
  let satellite: ReturnType<typeof viewer.imageryLayers.addImageryProvider> | undefined;
  el<HTMLInputElement>('satellite').onchange = () => {
    if (!satellite) {
      satellite = viewer.imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({
        url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        credit:'Esri, Maxar, Earthstar Geographics, and the GIS User Community', maximumLevel:18
      }), 1);
      satellite.imageryProvider.errorEvent.addEventListener(() => {
        el('run-info').textContent = 'Online imagery unavailable. Local terrain and replay remain available.';
      });
    }
    satellite.show = el<HTMLInputElement>('satellite').checked;
    localShade.alpha = satellite.show ? .32 : 1;
  };
  el<HTMLInputElement>('shade').onchange = () => { localShade.show = el<HTMLInputElement>('shade').checked; };
  viewer.clock.startTime = start.clone(); viewer.clock.stopTime = end.clone();
  viewer.clock.currentTime = start.clone(); viewer.clock.clockRange = ClockRange.CLAMPED;
  viewer.clock.multiplier = 20;
  let active = false;
  let rfData: ReturnType<typeof generateRfScenario> | undefined;
  let rfView: ScenarioView | undefined;
  let rfTrail: EstimateTrail | undefined;
  let rfTrajectory: unknown;
  let rfIndex = -1;
  let rfUrls: string[] = [];
  const rfConfig = odesaRfConfig as SensorGeneratorConfig;
  for (const [index, receiver] of rfConfig.receivers.entries()) {
    el<HTMLInputElement>(`rf${index+1}-lat`).value=String(receiver.lat);
    el<HTMLInputElement>(`rf${index+1}-lon`).value=String(receiver.lon);
  }
  function clearRf() {
    rfTrail?.destroy(); rfTrail=undefined;
    rfView?.destroy(); rfView=undefined; rfData=undefined; rfIndex=-1;
    for (const url of rfUrls) URL.revokeObjectURL(url);
    rfUrls=[];
    for (const id of ['download-rf','download-rf-cot']) {
      el<HTMLAnchorElement>(id).removeAttribute('href'); el(id).setAttribute('aria-disabled','true');
    }
    el('rf-current').textContent='';
    el('rf-trail-stats').textContent='No RF estimates yet.';
  }
  function simulateRf() {
    clearRf();
    if (!rfTrajectory) return;
    const config=structuredClone(rfConfig);
    for (const [index, receiver] of config.receivers.entries()) {
      receiver.lat=el<HTMLInputElement>(`rf${index+1}-lat`).valueAsNumber;
      receiver.lon=el<HTMLInputElement>(`rf${index+1}-lon`).valueAsNumber;
    }
    try {
      rfData=generateRfScenario(rfTrajectory,config,{
        real:true,source:manifest.name+'; DSM + EGM2008 geoid',
        provenance:{elevation_sha256:manifest.assets.surface_elevation.sha256,geoid_sha256:manifest.assets.geoid_undulation.sha256},
        sample:point=>{
          try {
            const lon=CMath.toDegrees(point.longitude),lat=CMath.toDegrees(point.latitude);
            return sampleGrid(surface,lon,lat)+sampleGrid(geoid,lon,lat);
          } catch { return undefined; }
        },
      });
      rfView=new ScenarioView(viewer,[],rfData.replayFrames[0]!.detections.map(detection=>detection.receiver));
      rfTrail=new EstimateTrail(viewer,rfData.replayFrames,rfData.scenario.ground_truth);
      const report=rfData.report;
      el('rf-status').textContent=`${report.observations} detections · ${report.missed_detections} misses · ${report.successful_bearing_crossings}/${report.sample_count} fixes. Baseline ${(report.receiver_baseline_m/1000).toFixed(1)} km.`;
      for (const [id,content,type] of [
        ['download-rf',JSON.stringify(rfData.scenario,null,2)+'\n','application/json'],
        ['download-rf-cot',rfData.cot,'application/xml'],
      ]) {
        const url=URL.createObjectURL(new Blob([content!],{type})); rfUrls.push(url);
        el<HTMLAnchorElement>(id!).href=url;el(id!).removeAttribute('aria-disabled');
      }
    } catch (error) {
      clearRf(); el('rf-status').textContent=`RF generation rejected: ${(error as Error).message}`;
    }
  }
  el('apply-rf').onclick=simulateRf;
  const at = (time: JulianDate) => replayState(states, JulianDate.secondsDifference(time,start));
  const sample = (elapsed: number) => replayState(states, elapsed);
  const xyz = (state: TruthState, ground=false) => Cartesian3.fromDegrees(state.longitude_deg,state.latitude_deg,
    (ground ? sampleGrid(surface,state.longitude_deg,state.latitude_deg) : state.altitude_egm2008_m) * exaggeration +
    sampleGrid(geoid,state.longitude_deg,state.latitude_deg));
  /**
   * Flight-path angle, for pointing the nose along the climb. The true angle is
   * only a few degrees and reads as level, but matching the fully exaggerated
   * path overshoots to a 30-degree zoom climb. The square root splits the
   * difference and tracks the slider, and the clamp keeps a steep leg from ever
   * looking like a fighter. The window smooths out per-sample noise.
   */
  const PITCH_WINDOW_S = 2;
  const MAX_PITCH = CMath.toRadians(18);
  const climbAngle = (time: JulianDate) => {
    const t = JulianDate.secondsDifference(time,start);
    const from = Math.max(0,t-PITCH_WINDOW_S), to = Math.min(duration,t+PITCH_WINDOW_S);
    if (to <= from) return 0;
    const rise = (sample(to).altitude_egm2008_m - sample(from).altitude_egm2008_m) * Math.sqrt(exaggeration);
    const run = sample(t).ground_speed_mps * (to - from);
    if (run <= 0) return 0;
    return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.atan2(rise,run)));
  };
  const aircraft = viewer.entities.add({ name:'Synthetic aircraft',
    position:new CallbackPositionProperty(time => active ? xyz(at(time ?? viewer.clock.currentTime)) : undefined,false),
    orientation:new CallbackProperty(time => {
      if (!active) return undefined;
      const now = time ?? viewer.clock.currentTime;
      const state = at(now);
      return Transforms.headingPitchRollQuaternion(xyz(state),
        new HeadingPitchRoll(CMath.toRadians(state.heading_deg)+MQ9_MODEL.noseOffset,climbAngle(now),0));
    },false),
    model:{uri:MQ9_MODEL.uri,scale:1,minimumPixelSize:48,maximumScale:60},
    point:{pixelSize:7,color:Color.WHITE,outlineColor:Color.CYAN,outlineWidth:2},
    label:{text:'AIRCRAFT 001',font:'11px sans-serif',pixelOffset:new Cartesian2(0,-34),
      fillColor:Color.WHITE,style:LabelStyle.FILL_AND_OUTLINE,outlineWidth:3,verticalOrigin:VerticalOrigin.BOTTOM},
    viewFrom:new Cartesian3(-1800,-1800,1300)
  });
  let routePositions: Cartesian3[] = [];
  const rebuildRoute = () => { routePositions = states.map(state=>xyz(state)); };
  const route = viewer.entities.add({polyline:{positions:new CallbackProperty(()=>routePositions,false),width:3,
    material:new PolylineGlowMaterialProperty({glowPower:.14,color:Color.fromCssColorString('#68e8e3')})}});
  const tether = viewer.entities.add({polyline:{positions:new CallbackProperty(time=>{
    if (!active) return [];
    const state = at(time ?? viewer.clock.currentTime); return [xyz(state),xyz(state,true)];
  },false),width:1,material:Color.WHITE.withAlpha(.6)}});
  const bounds:number[] = manifest.grid.sample_center_bounds_wsen;
  const corners = [[bounds[0]!,bounds[1]!],[bounds[2]!,bounds[1]!],[bounds[2]!,bounds[3]!],[bounds[0]!,bounds[3]!],[bounds[0]!,bounds[1]!]];
  viewer.entities.add({polyline:{positions:corners.map(([lon,lat])=>Cartesian3.fromDegrees(lon!,lat!)),
    width:2,clampToGround:true,material:Color.fromCssColorString('#ecc37b')}});
  const runEntities = [aircraft, route, tether];
  for (const [index,label,color] of [[0,'START',Color.LIME],[1,'END',Color.ORANGE]] as const) {
    runEntities.push(viewer.entities.add({position:new CallbackPositionProperty(
      () => active ? xyz(states[index === 0 ? 0 : states.length - 1]!) : undefined, false),point:{pixelSize:8,color},
      label:{text:label,font:'10px sans-serif',pixelOffset:new Cartesian2(12,0),fillColor:color,
        style:LabelStyle.FILL_AND_OUTLINE,outlineWidth:3}}));
  }
  runEntities.forEach(entity => { entity.show = false; });
  const exagInput = el<HTMLInputElement>('exag'), exagOut = el('exag-out');
  const setExaggeration = (value: number) => {
    exaggeration = value;
    exagOut.textContent = `${value.toFixed(1)}\u00d7`;
    // A new provider instance is what invalidates the quadtree and re-tiles.
    viewer.terrainProvider = new LocalTerrainProvider(surface,geoid,manifest.attribution,value);
    rebuildRoute();
    viewer.scene.requestRender();
  };
  // Label on drag, re-tile on release: retiling on every input event would
  // throw away terrain the viewer is still building.
  exagInput.oninput = () => { exagOut.textContent = `${Number(exagInput.value).toFixed(1)}\u00d7`; };
  exagInput.onchange = () => { setExaggeration(Number(exagInput.value)); };
  setExaggeration(Number(exagInput.value));
  const follow = el<HTMLButtonElement>('follow');
  function overview() {
    viewer.trackedEntity = undefined; follow.setAttribute('aria-pressed','false');
    // An oblique view reveals the route's altitude without exaggerating the DSM.
    const center=Cartesian3.fromDegrees((w+e)/2,(s+n)/2,0);
    viewer.camera.lookAt(center,new HeadingPitchRange(CMath.toRadians(-24),CMath.toRadians(-30),46000));
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  }
  el('overview').onclick = overview;
  follow.onclick = () => { if (!active) return; if(viewer.trackedEntity) overview(); else {
    viewer.trackedEntity=aircraft; follow.setAttribute('aria-pressed','true');
  }};
  const play=el<HTMLButtonElement>('play'), timeline=el<HTMLInputElement>('timeline');
  timeline.max=String(duration); follow.disabled=true;
  play.onclick=()=>{if(JulianDate.greaterThanOrEquals(viewer.clock.currentTime,end)) viewer.clock.currentTime=start.clone();
    viewer.clock.shouldAnimate=!viewer.clock.shouldAnimate;};
  el('restart').onclick=()=>{viewer.clock.currentTime=start.clone();viewer.clock.shouldAnimate=false;};
  timeline.oninput=()=>{viewer.clock.currentTime=JulianDate.addSeconds(start,Number(timeline.value),new JulianDate());};
  el<HTMLSelectElement>('speed').onchange=()=>{viewer.clock.multiplier=Number(el<HTMLSelectElement>('speed').value);};
  const clockText=(seconds:number)=>`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
  viewer.clock.onTick.addEventListener(()=>{
    if (!active) return;
    const state=at(viewer.clock.currentTime);
    if (rfData && rfView) {
      const index=Math.min(rfData.replayFrames.length-1,Math.max(0,Math.floor(state.elapsed_s/rfData.scenario.sample_period_s)));
      if (index !== rfIndex) {
        const frame=rfData.replayFrames[index]!;
        const truth=rfData.scenario.ground_truth[index]!;
        rfView.setReports(frame.detections,frame.fix,Cartesian3.fromDegrees(truth.lon,truth.lat,truth.hae_m));
        const stats=rfTrail!.showThrough(index);
        el('rf-trail-stats').textContent=`${stats.count} estimates · Current error: ${stats.currentErrorM === undefined ? 'no fix' : stats.currentErrorM.toFixed(0)+' m'} · RMSE so far: ${stats.rmseM === undefined ? '—' : stats.rmseM.toFixed(0)+' m'}`;
        el('rf-current').textContent=`t=${frame.timestamp_s.toFixed(1)} s · ${frame.detections.map(detection=>`${detection.receiver.uid}: ${detection.rssiDbm.toFixed(1)} dBm ${detection.heard?'heard':'missed'}`).join(' · ')} · ${frame.fix?'FIX':'NO FIX'}`;
        rfIndex=index;
      }
    }
    if(state.elapsed_s>=duration) viewer.clock.shouldAnimate=false;
    play.textContent=viewer.clock.shouldAnimate?'Pause':'Play';timeline.value=String(state.elapsed_s);
    el('elapsed').textContent=`${clockText(state.elapsed_s)} / ${clockText(duration)}`;
    const ground=sampleGrid(surface,state.longitude_deg,state.latitude_deg);
    el('clearance').textContent=(state.altitude_egm2008_m-ground).toFixed(1);
    el('position').textContent=`${state.longitude_deg.toFixed(5)}, ${state.latitude_deg.toFixed(5)}`;
    el('altitude').textContent=`${state.altitude_egm2008_m.toFixed(1)} m`;
    el('surface').textContent=`${ground.toFixed(1)} m`;
    el('motion').textContent=`${state.ground_speed_mps.toFixed(1)} m/s · ${state.heading_deg.toFixed(1)}°`;
    el('utc').textContent=state.timestamp.slice(11,19);
  });
  const template = structuredClone(defaults);
  const form = el<HTMLFormElement>('run-form');
  const fields = el<HTMLFieldSetElement>('run-fields');
  const status = el('generation-status');
  const download = el<HTMLAnchorElement>('download-truth');
  const receiverDownload = el<HTMLAnchorElement>('download-receiver');
  let receiverUrl: string | undefined;
  const cancel = el<HTMLButtonElement>('cancel-generation');
  let worker: Worker | undefined, requestId = 0, downloadUrl: string | undefined;
  const number = (id: string) => el<HTMLInputElement>(`input-${id}`).valueAsNumber;
  const vary = el<HTMLInputElement>('input-vary');
  const varyFields = ['climb','altcommand','bandlow','bandhigh','step'];
  // Required-but-disabled inputs are skipped by reportValidity, which is what
  // keeps the constant-altitude path from tripping over the vertical fields.
  const syncVary = () => { for (const id of varyFields) el<HTMLInputElement>(`input-${id}`).disabled=!vary.checked; };
  vary.addEventListener('change',syncVary);
  const put = (id: string, value: string | number) => { el<HTMLInputElement>(`input-${id}`).value = String(value); };
  const [west, south, east, north] = bounds;
  for (const [id, min, max] of [['lon',west,east],['lat',south,north]] as const) {
    const input = el<HTMLInputElement>(`input-${id}`);
    input.min=String(min); input.max=String(max);
    input.title=`Available range: ${min} to ${max}`;
  }
  function populate(seed: number) {
    const i=template;
    put('object',i.object_id);
    put('seed',seed); put('duration',i.simulation.duration_s);
    put('lon',i.initial_state.longitude_deg); put('lat',i.initial_state.latitude_deg);
    put('speed',i.initial_state.ground_speed_mps); put('heading',i.initial_state.heading_deg);
    put('height',i.initial_state.height_above_surface_m); put('start',i.simulation.start_time);
    put('interval',i.simulation.output_interval_s); put('turn',i.movement.max_heading_rate_deg_s);
    put('command',i.movement.heading_change_interval_s);
    // The template may ship either altitude law, so fall back to sane values
    // rather than leaving the vertical fields empty and failing form validity.
    const m=i.movement as Movement;
    vary.checked=m.altitude_mode === 'smooth_random_agl';
    put('climb',m.max_climb_rate_mps ?? 5);
    put('altcommand',m.altitude_change_interval_s ?? 40);
    put('bandlow',m.height_band_m?.[0] ?? i.validation.minimum_surface_clearance_m * 3);
    put('bandhigh',m.height_band_m?.[1] ?? 2000);
    put('step',m.height_step_m ?? 350);
    const floor=String(i.validation.minimum_surface_clearance_m);
    el<HTMLInputElement>('input-height').min=floor;
    el<HTMLInputElement>('input-bandlow').min=floor;
    el<HTMLInputElement>('input-bandhigh').min=floor;
    syncVary();
  }
  function clearRun() {
    clearRf();rfTrajectory=undefined;el<HTMLButtonElement>('apply-rf').disabled=true;
    el('rf-status').textContent='Generate a trajectory to simulate RF reception.';
    active=false; viewer.clock.shouldAnimate=false; viewer.trackedEntity=undefined;
    follow.setAttribute('aria-pressed','false'); follow.disabled=true;
    play.disabled=true; play.textContent='Play'; timeline.disabled=true; timeline.value='0';
    el<HTMLButtonElement>('restart').disabled=true;
    runEntities.forEach(entity => { entity.show=false; });
    for (const id of ['clearance','position','altitude','surface','motion','utc']) el(id).textContent='—';
    el('elapsed').textContent='Not generated';
    el('run-info').textContent='Generate a trajectory to inspect its validation results.';
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl=undefined; download.removeAttribute('href'); download.setAttribute('aria-disabled','true');
    if (receiverUrl) URL.revokeObjectURL(receiverUrl);
    receiverUrl=undefined; receiverDownload.removeAttribute('href'); receiverDownload.setAttribute('aria-disabled','true');
  }
  function dirty() {
    clearRun(); status.textContent='Settings changed. Generate a trajectory before playing.';
    status.dataset.state='pending';
  }
  function busy(value: boolean) {
    fields.disabled=value; cancel.hidden=!value;
  }
  function failed(message: string) {
    busy(false); status.dataset.state='error'; status.textContent=message;
  }
  populate(template.simulation.seed); fields.disabled=false;
  status.textContent='Choose settings, then generate. The same seed and settings repeat the same path.';
  el<HTMLSelectElement>('preset').value=String(template.simulation.seed) === '42' ? '42' : 'custom';
  form.addEventListener('input',event=>{
    if ((event.target as HTMLElement).id === 'preset') return;
    el<HTMLSelectElement>('preset').value='custom'; dirty();
  });
  el<HTMLSelectElement>('preset').onchange=()=>{
    const value=el<HTMLSelectElement>('preset').value;
    if(value !== 'custom') populate(Number(value));
    dirty();
  };
  el('new-seed').onclick=()=>{
    put('seed',crypto.getRandomValues(new Uint32Array(1))[0]!);
    el<HTMLSelectElement>('preset').value='custom'; dirty();
  };
  cancel.onclick=()=>{
    requestId++; worker?.terminate(); worker=undefined; busy(false);
    status.dataset.state='pending'; status.textContent='Generation cancelled. Adjust settings or generate again.';
  };
  form.onsubmit=event=>{
    event.preventDefault();
    if (!form.reportValidity()) return;
    clearRun(); busy(true); status.dataset.state='pending'; status.textContent='Generating and checking the full path…';
    const input=structuredClone(template);
    input.object_id=el<HTMLInputElement>('input-object').value.trim();
    Object.assign(input.initial_state,{longitude_deg:number('lon'),latitude_deg:number('lat'),
      height_above_surface_m:number('height'),ground_speed_mps:number('speed'),heading_deg:number('heading')});
    Object.assign(input.simulation,{seed:number('seed'),duration_s:number('duration'),output_interval_s:number('interval'),
      start_time:el<HTMLInputElement>('input-start').value.trim()});
    Object.assign(input.movement,{max_heading_rate_deg_s:number('turn'),heading_change_interval_s:number('command')});
    // validateConfig asserts an exact key set per mode, so the vertical fields
    // have to be removed rather than left behind when the toggle is off.
    const movement=input.movement as Movement;
    if (vary.checked) {
      movement.altitude_mode='smooth_random_agl';
      movement.max_climb_rate_mps=number('climb');
      movement.altitude_change_interval_s=number('altcommand');
      movement.height_band_m=[number('bandlow'),number('bandhigh')];
      movement.height_step_m=number('step');
    } else {
      movement.altitude_mode='constant_egm2008_height';
      delete movement.max_climb_rate_mps;
      delete movement.altitude_change_interval_s;
      delete movement.height_band_m;
      delete movement.height_step_m;
    }
    try {
      worker ??= new Worker(new URL('./trajectory-worker.ts',import.meta.url),{type:'module'});
    } catch (error) {
      failed(`Could not start generation: ${(error as Error).message}`); return;
    }
    worker.onerror=event=>{
      worker?.terminate(); worker=undefined;
      failed(`Generation failed: ${event.message || 'worker could not start'}. Try again.`);
    };
    worker.onmessage=({data})=>{
      if (data.id !== requestId) return;
      if(data.error) {
        const atTime=data.error.elapsed_s === undefined ? '' : ` at ${data.error.elapsed_s.toFixed(1)} s`;
        const hint=data.error.code === 'OUT_OF_BOUNDS' ? ' Try a shorter duration, another start or another seed.' : '';
        failed(`Generation rejected${atTime}: ${data.error.message}.${hint}`); return;
      }
      const generated=data.output;
      aircraft.label!.text=new ConstantProperty(generated.resolved_input.object_id);
      states=[...generated.trajectory_truth,generated.validation.terminal_state];
      duration=generated.resolved_input.simulation.duration_s;
      start=JulianDate.fromIso8601(states[0]!.timestamp); end=JulianDate.addSeconds(start,duration,new JulianDate());
      viewer.clock.startTime=start.clone(); viewer.clock.stopTime=end.clone(); viewer.clock.currentTime=start.clone();
      viewer.clock.shouldAnimate=false;
      rebuildRoute();
      runEntities.forEach(entity=>{entity.show=true;});
      active=true; timeline.max=String(duration); timeline.value='0'; timeline.disabled=false;
      play.disabled=false; follow.disabled=false; el<HTMLButtonElement>('restart').disabled=false;
      downloadUrl=URL.createObjectURL(new Blob([JSON.stringify(generated,null,2)+'\n'],{type:'application/json'}));
      download.href=downloadUrl; download.removeAttribute('aria-disabled');
      receiverUrl=URL.createObjectURL(new Blob([JSON.stringify(data.receiverOutput,null,2)+'\n'],{type:'application/json'}));
      receiverDownload.href=receiverUrl; receiverDownload.removeAttribute('aria-disabled');
      rfTrajectory={...data.receiverOutput,start_utc:generated.resolved_input.simulation.start_time,duration_s:generated.resolved_input.simulation.duration_s};
      el<HTMLButtonElement>('apply-rf').disabled=false;
      simulateRf();
      el('run-info').textContent=`${generated.trajectory_truth.length} exported states + endpoint · Seed ${generated.resolved_input.simulation.seed}. Minimum checked clearance ${generated.validation.minimum_surface_clearance_m.toFixed(1)} m. Playback interpolates between truth samples.`;
      busy(false); status.dataset.state='ready'; status.textContent='Trajectory ready. Press Play or scrub the timeline.';
    };
    worker.postMessage({id:++requestId,input,scenarioId:el<HTMLInputElement>('input-scenario').value.trim(),assetsBase:new URL(asset(''),location.href).href});
  };
  window.addEventListener('pagehide',()=>{worker?.terminate();clearRf();if(downloadUrl) URL.revokeObjectURL(downloadUrl);if(receiverUrl) URL.revokeObjectURL(receiverUrl);});
  overview(); el('loading').remove();
}
main().catch(error=>{console.error(error);el('loading').textContent=`Unable to load replay: ${error.message}. Run npm run dev to prepare local assets.`;});
