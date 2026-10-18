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

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const asset = (name: string) => `${import.meta.env.BASE_URL}trajectory/${name}`;
async function get(name: string) {
  const response = await fetch(asset(name));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response;
}
async function main() {
  const [manifest, defaults, geoid, demBytes, shadeBytes] = await Promise.all([
    get('manifest.json').then(r => r.json()), get('defaults.json').then(r => r.json()),
    get('geoid-egm2008.json').then(r => r.json()) as Promise<Grid>,
    get('elevation.tif').then(r => r.arrayBuffer()), get('hillshade.tif').then(r => r.arrayBuffer())
  ]);
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
    terrainProvider: new LocalTerrainProvider(surface, geoid, manifest.attribution),
    animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,
    sceneModePicker:false,navigationHelpButton:false,fullscreenButton:false,
    selectionIndicator:false,infoBox:false,shouldAnimate:false });
  viewer.imageryLayers.addImageryProvider(base);
  viewer.scene.globe.baseColor = Color.fromCssColorString('#1b3445');
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.enableLighting = false;
  viewer.scene.verticalExaggeration = 1;
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
  const at = (time: JulianDate) => replayState(states, JulianDate.secondsDifference(time,start));
  const xyz = (state: TruthState, ground=false) => Cartesian3.fromDegrees(state.longitude_deg,state.latitude_deg,
    (ground ? sampleGrid(surface,state.longitude_deg,state.latitude_deg) : state.altitude_egm2008_m) +
    sampleGrid(geoid,state.longitude_deg,state.latitude_deg));
  const aircraft = viewer.entities.add({ name:'Synthetic aircraft',
    position:new CallbackPositionProperty(time => active ? xyz(at(time ?? viewer.clock.currentTime)) : undefined,false),
    orientation:new CallbackProperty(time => {
      if (!active) return undefined;
      const state = at(time ?? viewer.clock.currentTime);
      return Transforms.headingPitchRollQuaternion(xyz(state),new HeadingPitchRoll(CMath.toRadians(state.heading_deg)+MQ9_MODEL.noseOffset,0,0));
    },false),
    model:{uri:MQ9_MODEL.uri,scale:1,minimumPixelSize:64,maximumScale:400},
    point:{pixelSize:7,color:Color.WHITE,outlineColor:Color.CYAN,outlineWidth:2},
    label:{text:'AIRCRAFT 001',font:'11px sans-serif',pixelOffset:new Cartesian2(0,-34),
      fillColor:Color.WHITE,style:LabelStyle.FILL_AND_OUTLINE,outlineWidth:3,verticalOrigin:VerticalOrigin.BOTTOM},
    viewFrom:new Cartesian3(-1800,-1800,1300)
  });
  const route = viewer.entities.add({polyline:{positions:states.map(state=>xyz(state)),width:3,
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
  const follow = el<HTMLButtonElement>('follow');
  function overview() {
    viewer.trackedEntity = undefined; follow.setAttribute('aria-pressed','false');
    // An oblique view reveals the route's altitude without exaggerating the DSM.
    const center=Cartesian3.fromDegrees((w+e)/2,(s+n)/2,0);
    viewer.camera.lookAt(center,new HeadingPitchRange(0,CMath.toRadians(-60),54000));
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
    el<HTMLInputElement>('input-height').min=String(i.validation.minimum_surface_clearance_m);
  }
  function clearRun() {
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
      route.polyline!.positions=new ConstantProperty(states.map(state=>xyz(state)));
      runEntities.forEach(entity=>{entity.show=true;});
      active=true; timeline.max=String(duration); timeline.value='0'; timeline.disabled=false;
      play.disabled=false; follow.disabled=false; el<HTMLButtonElement>('restart').disabled=false;
      downloadUrl=URL.createObjectURL(new Blob([JSON.stringify(generated,null,2)+'\n'],{type:'application/json'}));
      download.href=downloadUrl; download.removeAttribute('aria-disabled');
      receiverUrl=URL.createObjectURL(new Blob([JSON.stringify(data.receiverOutput,null,2)+'\n'],{type:'application/json'}));
      receiverDownload.href=receiverUrl; receiverDownload.removeAttribute('aria-disabled');
      el('run-info').textContent=`${generated.trajectory_truth.length} exported states + endpoint · Seed ${generated.resolved_input.simulation.seed}. Minimum checked clearance ${generated.validation.minimum_surface_clearance_m.toFixed(1)} m. Playback interpolates between truth samples.`;
      busy(false); status.dataset.state='ready'; status.textContent='Trajectory ready. Press Play or scrub the timeline.';
    };
    worker.postMessage({id:++requestId,input,scenarioId:el<HTMLInputElement>('input-scenario').value.trim(),assetsBase:new URL(asset(''),location.href).href});
  };
  window.addEventListener('pagehide',()=>{worker?.terminate();if(downloadUrl) URL.revokeObjectURL(downloadUrl);if(receiverUrl) URL.revokeObjectURL(receiverUrl);});
  overview(); el('loading').remove();
}
main().catch(error=>{console.error(error);el('loading').textContent=`Unable to load replay: ${error.message}. Run npm run dev to prepare local assets.`;});
