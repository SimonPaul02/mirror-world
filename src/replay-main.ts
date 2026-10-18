import './cesium-base-url';
import './replay.css';
import { Viewer, TileMapServiceImageryProvider, SingleTileImageryProvider, UrlTemplateImageryProvider,
  buildModuleUrl, Cartesian3, Cartographic, Color, Rectangle, Math as CMath, CallbackPositionProperty,
  CallbackProperty, HeadingPitchRoll, Transforms, JulianDate, ClockRange, HeadingPitchRange,
  PolylineGlowMaterialProperty, Cartesian2, LabelStyle, VerticalOrigin, Matrix4, ConstantProperty, SceneMode, type Entity } from 'cesium';
import { fromArrayBuffer } from 'geotiff';
import { LocalTerrainProvider } from './local-terrain';
import { sampleGrid, replayState, type Grid, type TruthState } from './replay-math';
import { MQ9_MODEL } from './models';
import { generateRfScenario, type SensorGeneratorConfig } from './sensor-generator';
import { ScenarioView } from './scenario-view';
import { EstimateTrail } from './estimate-trail';
import { receiverControls } from './receiver-controls';
import type { CropBounds } from './scenario-config';
import { droneControls } from './drone-controls';
import type { DroneTrajectory } from './trajectory';
import { optionalSensorControls, generateOptionalSensors } from './optional-sensors';
import { mapPlacement } from './map-placement';
import odesaRfConfig from '../examples/rf_sensor_odesa.json';

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
  let primaryStates: TruthState[]=[];
  type Flight={objectId:string;trajectory:DroneTrajectory;states:TruthState[];fullTruth:unknown;entity?:Entity};
  let flights: Flight[]=[];
  let selectedDrone=0;
  const extraEntities: Entity[]=[];
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
  const contextImage=canvas.toDataURL();
  const [w,s,e,n] = manifest.grid.pixel_edge_bounds_wsen;
  const localShade = viewer.imageryLayers.addImageryProvider(await SingleTileImageryProvider.fromUrl(
    contextImage, {rectangle:Rectangle.fromDegrees(w,s,e,n), credit:manifest.attribution}));
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
  let rfTrails: EstimateTrail[]=[];
  let rfResults: ReturnType<typeof generateRfScenario>[]=[];
  let optionalData: ReturnType<typeof generateOptionalSensors> | undefined;
  const optionalEntities:Entity[]=[];
  let rfIndex = -1;
  let rfUrls: string[] = [];
  const rfConfig = odesaRfConfig as SensorGeneratorConfig;
  const sampleTerrain=(point: import('cesium').Cartographic)=>{
    try {const lon=CMath.toDegrees(point.longitude),lat=CMath.toDegrees(point.latitude);return sampleGrid(surface,lon,lat)+sampleGrid(geoid,lon,lat);} catch {return undefined;}
  };
  const placement=mapPlacement(viewer,sampleTerrain);
  const receiverEditor=receiverControls(rfConfig,manifest.grid.sample_center_bounds_wsen as CropBounds,sampleTerrain,()=>{
    placement.cancel();clearRf();el('rf-status').textContent='Receiver settings changed. Apply sensor configuration to regenerate records.';
  },placement.start);
  const optionalEditor=optionalSensorControls(manifest.grid.sample_center_bounds_wsen as CropBounds,sampleTerrain,()=>{
    placement.cancel();clearRf();el('rf-status').textContent='Sensor settings changed. Apply sensor configuration to regenerate records.';
  },placement.start);
  el<HTMLSelectElement>('preview-source').onchange=()=>{rfIndex=-1;};
  function clearRf() {
    for(const trail of rfTrails) trail.destroy();rfTrails=[];rfResults=[];
    optionalData=undefined;for(const entity of optionalEntities) viewer.entities.remove(entity);optionalEntities.length=0;
    el('optional-status').textContent='Apply sensor configuration to generate optional sensor records.';el('sensor-preview').hidden=true;
    el<HTMLImageElement>('sensor-preview-image').removeAttribute('src');el<HTMLSelectElement>('preview-source').replaceChildren();
    rfView?.destroy(); rfView=undefined; rfData=undefined; rfIndex=-1;
    for (const url of rfUrls) URL.revokeObjectURL(url);
    rfUrls=[];
    for (const id of ['download-rf','download-rf-cot','download-bundle']) {
      el<HTMLAnchorElement>(id).removeAttribute('href'); el(id).setAttribute('aria-disabled','true');
    }
    el('rf-current').textContent='';
    el('rf-trail-stats').textContent='No RF estimates yet.';
  }
  function simulateRf() {
    placement.cancel();
    clearRf();
    if (!flights.length) return;
    const config=structuredClone(rfConfig);
    try {
      config.receivers=receiverEditor.read();
      rfResults=flights.map((flight,index)=>generateRfScenario(flight.trajectory,{...config,seed:(config.seed+index)>>>0,emitter:{...config.emitter,freqMhz:config.emitter.freqMhz+index*5}},{
        real:true,source:manifest.name+'; DSM + EGM2008 geoid',
        provenance:{elevation_sha256:manifest.assets.surface_elevation.sha256,geoid_sha256:manifest.assets.geoid_undulation.sha256},
        sample:sampleTerrain,
      }));
      rfTrails=rfResults.map(result=>new EstimateTrail(viewer,result.replayFrames,result.scenario.ground_truth));
      optionalData=generateOptionalSensors(optionalEditor.read(flights),flights,sampleTerrain,{
        data_uri:contextImage,bounds:manifest.grid.pixel_edge_bounds_wsen as CropBounds,width_px:canvas.width,height_px:canvas.height,source_pixel_size_degrees:manifest.grid.pixel_size_degrees,
        attribution:typeof manifest.attribution==='string'?manifest.attribution:JSON.stringify(manifest.attribution),source_id:manifest.terrain_id??'odesa_terrain',
      });
      const previewSelect=el<HTMLSelectElement>('preview-source');
      for(const sensor of [...optionalData.configuration.cameras.map(camera=>camera.id),...Array.from({length:optionalData.configuration.satellite_count},(_,index)=>`SAT${index+1}`)]) {
        const option=document.createElement('option');option.value=sensor;option.textContent=sensor;previewSelect.append(option);
      }
      el('optional-status').textContent=`${optionalData.camera_frames.length} schematic camera frames · ${optionalData.satellite_images.length} satellite context records. Included in complete scenario download.`;
      for(const camera of optionalData.configuration.cameras) {
        const host=flights.find(flight=>flight.objectId===camera.host_object_id);
        const position=new CallbackPositionProperty(()=>{
          if(host) return xyz(replayState(host.states,JulianDate.secondsDifference(viewer.clock.currentTime,start)));
          return Cartesian3.fromDegrees(camera.lon,camera.lat,sampleTerrain(Cartographic.fromDegrees(camera.lon,camera.lat))!+camera.height_agl_m);
        },false);
        optionalEntities.push(viewer.entities.add({position,point:{pixelSize:8,color:Color.LIGHTSKYBLUE,disableDepthTestDistance:Number.POSITIVE_INFINITY},label:{text:camera.id,font:'11px sans-serif',fillColor:Color.LIGHTSKYBLUE,pixelOffset:new Cartesian2(12,12),disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
      }
      selectDrone(selectedDrone);
      const bundle={schema_version:2,scenario_id:flights[0]!.trajectory.scenario_id,configuration:{rf:config,drone_count:flights.length,rf_placement_mode:el<HTMLSelectElement>('rf-placement').value,camera_placement_mode:el<HTMLSelectElement>('camera-placement').value,placement_seed:el<HTMLInputElement>('placement-seed').valueAsNumber,emitter_separation:'Distinct configured frequencies, ideal channel separation; no RF data association model'},trajectories:flights.map(flight=>flight.trajectory),rf_scenarios:rfResults.map(result=>result.scenario),optional_sensors:optionalData};
      setDownload('download-bundle',JSON.stringify(bundle,null,2)+'\n','application/json');
      placement.cancel();
    } catch (error) {
      clearRf(); el('rf-status').textContent=`Sensor generation rejected: ${(error as Error).message}`;
    }
  }
  function setDownload(id:string,content:string,type:string) {
    const link=el<HTMLAnchorElement>(id);
    if(link.href.startsWith('blob:')) {URL.revokeObjectURL(link.href);rfUrls=rfUrls.filter(url=>url!==link.href);}
    const url=URL.createObjectURL(new Blob([content],{type}));rfUrls.push(url);link.href=url;link.removeAttribute('aria-disabled');
  }
  function selectDrone(index:number) {
    selectedDrone=index;states=flights[index]!.states;rfData=rfResults[index];rfIndex=-1;
    rfView?.destroy();rfView=undefined;
    if(rfData) {
      rfView=new ScenarioView(viewer,[],rfData.replayFrames[0]!.detections.map(detection=>detection.receiver));
      const report=rfData.report,count=rfData.scenario.sensors.length;
      el('rf-status').textContent=`${flights[index]!.objectId}: ${report.observations} detections · ${report.missed_detections} misses · ${report.successful_bearing_crossings}/${report.sample_count} fixes. Widest baseline ${(report.receiver_baseline_m/1000).toFixed(1)} km.${count<2?' Fewer than two RF sites: no RF position fix.':''}`;
      setDownload('download-rf',JSON.stringify(rfData.scenario,null,2)+'\n','application/json');setDownload('download-rf-cot',rfData.cot,'application/xml');
    }
    if(viewer.trackedEntity) viewer.trackedEntity=flights[index]!.entity;
  }
  el<HTMLSelectElement>('inspect-drone').onchange=()=>selectDrone(Number(el<HTMLSelectElement>('inspect-drone').value));
  el('apply-rf').onclick=simulateRf;
  const at = (time: JulianDate) => replayState(states, JulianDate.secondsDifference(time,start));
  const primaryAt = (time: JulianDate) => replayState(primaryStates, JulianDate.secondsDifference(time,start));
  const xyz = (state: TruthState, ground=false) => Cartesian3.fromDegrees(state.longitude_deg,state.latitude_deg,
    (ground ? sampleGrid(surface,state.longitude_deg,state.latitude_deg) : state.altitude_egm2008_m) +
    sampleGrid(geoid,state.longitude_deg,state.latitude_deg));
  const aircraft = viewer.entities.add({ name:'Synthetic aircraft',
    position:new CallbackPositionProperty(time => active ? xyz(primaryAt(time ?? viewer.clock.currentTime)) : undefined,false),
    orientation:new CallbackProperty(time => {
      if (!active) return undefined;
      const state = primaryAt(time ?? viewer.clock.currentTime);
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
    const state = primaryAt(time ?? viewer.clock.currentTime); return [xyz(state),xyz(state,true)];
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
    if (viewer.scene.mode===SceneMode.SCENE2D) {
      viewer.camera.setView({destination:Rectangle.fromDegrees(w,s,e,n)});return;
    }
    // An oblique view reveals the route's altitude without exaggerating the DSM.
    const center=Cartesian3.fromDegrees((w+e)/2,(s+n)/2,0);
    viewer.camera.lookAt(center,new HeadingPitchRange(0,CMath.toRadians(-60),54000));
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  }
  el('overview').onclick = overview;
  function changeView(flat:boolean) {
    viewer.trackedEntity=undefined;
    if(flat) viewer.scene.morphTo2D(0);else viewer.scene.morphTo3D(0);
    el('view-2d').setAttribute('aria-pressed',String(flat));el('view-3d').setAttribute('aria-pressed',String(!flat));
    follow.disabled=!active||flat;overview();
    el('map-note').textContent=flat?'Drag to pan · Scroll to zoom':'Drag to orbit · Scroll to zoom · Ctrl + drag to tilt';
  }
  el('view-2d').onclick=()=>changeView(true);el('view-3d').onclick=()=>changeView(false);
  const navigationStep=()=>{
    const frustum=viewer.camera.frustum as {right?:number;left?:number};
    return Math.max(100,viewer.scene.mode===SceneMode.SCENE2D?(frustum.right!-frustum.left!)*.15:viewer.camera.positionCartographic.height*.15);
  };
  el('nav-in').onclick=()=>viewer.camera.zoomIn(navigationStep());el('nav-out').onclick=()=>viewer.camera.zoomOut(navigationStep());
  el('nav-north').onclick=()=>{viewer.trackedEntity=undefined;viewer.camera.setView({orientation:{heading:0,pitch:viewer.camera.pitch,roll:0}});};
  document.querySelectorAll<HTMLButtonElement>('[data-pan]').forEach(button=>{button.onclick=()=>{
    viewer.trackedEntity=undefined;const amount=navigationStep();
    if(button.dataset.pan==='left') viewer.camera.moveLeft(amount);
    if(button.dataset.pan==='right') viewer.camera.moveRight(amount);
    if(button.dataset.pan==='up') viewer.camera.moveUp(amount);
    if(button.dataset.pan==='down') viewer.camera.moveDown(amount);
  };});
  follow.onclick = () => { if (!active) return; if(viewer.trackedEntity) overview(); else {
    viewer.trackedEntity=flights[selectedDrone]?.entity??aircraft; follow.setAttribute('aria-pressed','true');
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
        const stats=rfTrails[selectedDrone]!.showThrough(index);
        for(const [other,trail] of rfTrails.entries()) if(other!==selectedDrone) trail.showThrough(index);
        if(optionalData) {
          const sensor=el<HTMLSelectElement>('preview-source').value;
          const camera=[...optionalData.camera_frames].reverse().find(frame=>frame.sensor_id===sensor&&frame.timestamp_s<=state.elapsed_s);
          const satellite=[...optionalData.satellite_images].reverse().find(frame=>frame.sensor_id===sensor&&frame.timestamp_s<=state.elapsed_s);
          el('sensor-preview').hidden=!camera&&!satellite;
          if(camera) {
            el<HTMLImageElement>('sensor-preview-image').src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(camera.svg);
            el('sensor-preview-caption').textContent=`${sensor} · t=${camera.timestamp_s}s · ${camera.detections.length} resolved targets · schematic frame`;
          } else if(satellite) {
            el<HTMLImageElement>('sensor-preview-image').src=contextImage;
            el('sensor-preview-caption').textContent=`${sensor} · t=${satellite.timestamp_s}s · static DSM hillshade context; no optical acquisition`;
          }
        }
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
  const put = (id: string, value: string | number) => { el<HTMLInputElement>(`input-${id}`).value = String(value); };
  const [west, south, east, north] = bounds;
  const droneEditor=droneControls(bounds as unknown as CropBounds);
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
    placement.cancel();
    clearRf();flights=[];primaryStates=[];states=[];selectedDrone=0;
    for(const entity of extraEntities) viewer.entities.remove(entity);extraEntities.length=0;
    el<HTMLSelectElement>('inspect-drone').replaceChildren();el<HTMLSelectElement>('inspect-drone').disabled=true;
    el<HTMLButtonElement>('apply-rf').disabled=true;
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
      flights=(data.flights??[{output:data.output,receiverOutput:data.receiverOutput}]).map((item: {output: typeof generated;receiverOutput: DroneTrajectory})=>({
        objectId:item.output.resolved_input.object_id,
        trajectory:{...item.receiverOutput,start_utc:item.output.resolved_input.simulation.start_time,duration_s:item.output.resolved_input.simulation.duration_s},
        states:[...item.output.trajectory_truth,item.output.validation.terminal_state],fullTruth:item.output,
      }));
      selectedDrone=0;primaryStates=flights[0]!.states;flights[0]!.entity=aircraft;
      const selector=el<HTMLSelectElement>('inspect-drone');selector.replaceChildren();selector.disabled=false;
      for(const [index,flight] of flights.entries()) {
        const option=document.createElement('option');option.value=String(index);option.textContent=flight.objectId;selector.append(option);
        if(index===0) continue;
        const color=Color.fromCssColorString(['#a9cbff','#d5a9ff','#ffbddd','#b3e7e1'][index-1]!);
        const stateAt=(time:JulianDate)=>replayState(flight.states,JulianDate.secondsDifference(time,start));
        flight.entity=viewer.entities.add({position:new CallbackPositionProperty(time=>xyz(stateAt(time??viewer.clock.currentTime)),false),
          orientation:new CallbackProperty(time=>{const state=stateAt(time??viewer.clock.currentTime);return Transforms.headingPitchRollQuaternion(xyz(state),new HeadingPitchRoll(CMath.toRadians(state.heading_deg)+MQ9_MODEL.noseOffset,0,0));},false),
          model:{uri:MQ9_MODEL.uri,minimumPixelSize:48,maximumScale:300},point:{pixelSize:7,color},
          label:{text:flight.objectId,font:'11px sans-serif',fillColor:color,pixelOffset:new Cartesian2(0,-30),style:LabelStyle.FILL_AND_OUTLINE,outlineWidth:3},viewFrom:new Cartesian3(-1800,-1800,1300)});
        extraEntities.push(flight.entity,viewer.entities.add({polyline:{positions:flight.states.map(state=>xyz(state)),width:2,material:color.withAlpha(.7)}}));
      }
      aircraft.label!.text=new ConstantProperty(generated.resolved_input.object_id);
      states=[...generated.trajectory_truth,generated.validation.terminal_state];
      duration=generated.resolved_input.simulation.duration_s;
      start=JulianDate.fromIso8601(states[0]!.timestamp); end=JulianDate.addSeconds(start,duration,new JulianDate());
      viewer.clock.startTime=start.clone(); viewer.clock.stopTime=end.clone(); viewer.clock.currentTime=start.clone();
      viewer.clock.shouldAnimate=false;
      route.polyline!.positions=new ConstantProperty(states.map(state=>xyz(state)));
      runEntities.forEach(entity=>{entity.show=true;});
      active=true; timeline.max=String(duration); timeline.value='0'; timeline.disabled=false;
      play.disabled=false; follow.disabled=viewer.scene.mode===SceneMode.SCENE2D; el<HTMLButtonElement>('restart').disabled=false;
      downloadUrl=URL.createObjectURL(new Blob([JSON.stringify(flights.length===1?generated:{flights:flights.map(flight=>flight.fullTruth)},null,2)+'\n'],{type:'application/json'}));
      download.href=downloadUrl; download.removeAttribute('aria-disabled');
      receiverUrl=URL.createObjectURL(new Blob([JSON.stringify(flights.length===1?flights[0]!.trajectory:{trajectories:flights.map(flight=>flight.trajectory)},null,2)+'\n'],{type:'application/json'}));
      receiverDownload.href=receiverUrl; receiverDownload.removeAttribute('aria-disabled');
      el<HTMLButtonElement>('apply-rf').disabled=false;
      simulateRf();
      el('run-info').textContent=`${flights.length} drone(s) · ${generated.trajectory_truth.length} exported states + endpoint per drone · Seed ${generated.resolved_input.simulation.seed}. Minimum checked clearance ${generated.validation.minimum_surface_clearance_m.toFixed(1)} m for drone 1. Every flight is terrain-validated. Playback interpolates between truth samples.`;
      busy(false); status.dataset.state='ready'; status.textContent='Trajectory ready. Press Play or scrub the timeline.';
    };
    const inputs=[input,...droneEditor.read().map((initial,index)=>{
      const extra=structuredClone(input);extra.object_id=initial.object_id;Object.assign(extra.initial_state,initial);delete extra.initial_state.object_id;
      extra.simulation.seed=(input.simulation.seed+index+1)>>>0;return extra;
    })];
    worker.postMessage({id:++requestId,input,inputs,scenarioId:el<HTMLInputElement>('input-scenario').value.trim(),assetsBase:new URL(asset(''),location.href).href});
  };
  window.addEventListener('pagehide',()=>{worker?.terminate();clearRf();placement.destroy();if(downloadUrl) URL.revokeObjectURL(downloadUrl);if(receiverUrl) URL.revokeObjectURL(receiverUrl);});
  overview(); el('loading').remove();
}
main().catch(error=>{console.error(error);el('loading').textContent=`Unable to load replay: ${error.message}. Run npm run dev to prepare local assets.`;});
