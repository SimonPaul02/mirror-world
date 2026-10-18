import { Cartesian3, Cartographic, Matrix4, Transforms, Math as CMath } from 'cesium';
import type { DroneTrajectory } from './trajectory';
import type { CropBounds } from './scenario-config';
import type { TruthState } from './replay-math';
import { mulberry32 } from './math';

export interface CameraConfig {
  id:string; platform:'fixed'|'drone'; host_object_id?:string;
  lat:number; lon:number; height_agl_m:number; heading_deg:number; pitch_deg:number;
  horizontal_fov_deg:number; width_px:number; height_px:number;
}
export interface OptionalConfig { cameras:CameraConfig[]; satellite_count:number; interval_s:number }
type Flight={objectId:string;trajectory:DroneTrajectory;states:TruthState[]};
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));

export function optionalSensorControls(bounds:CropBounds,sample:(point:Cartographic)=>number|undefined,changed:()=>void,place:(label:string,placed:(lat:number,lon:number)=>void)=>void) {
  const input=(id:string)=>document.getElementById(id) as HTMLInputElement;
  function cameras() {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-camera]'),row=>{
      const get=(field:string)=>(row.querySelector(`[data-${field}]`) as HTMLInputElement).value;
      const host=Number(get('host'));
      return {id:row.dataset.camera!,platform:get('platform') as CameraConfig['platform'],host_index:host,
        lat:Number(get('lat')),lon:Number(get('lon')),height_agl_m:12,heading_deg:Number(get('heading')),pitch_deg:Number(get('pitch')),
        horizontal_fov_deg:20,width_px:1920,height_px:1080};
    });
  }
  function render() {
    const count=input('camera-count').valueAsNumber,existing=cameras(),container=document.getElementById('camera-sites')!;
    if(!Number.isInteger(count)||count<0||count>5) return;
    if(container.children.length===count) return;
    container.replaceChildren();
    for(let index=0;index<count;index++) {
      const old=existing[index];
      const section=document.createElement('div');section.dataset.camera=`CAM${index+1}`;section.className='drone-start';
      const title=document.createElement('strong');title.textContent=`Camera ${index+1}`;section.append(title);
      const grid=document.createElement('div');grid.className='form-grid';section.append(grid);
      const add=(labelText:string,field:string,value:string|number,options?:Array<[string,string]>)=>{
        const label=document.createElement('label');label.className='field';label.textContent=labelText;
        const control=options?document.createElement('select'):document.createElement('input');control.dataset[field]='';
        if(control instanceof HTMLSelectElement) for(const [val,text] of options!) {const option=document.createElement('option');option.value=val;option.textContent=text;control.append(option);}
        if(control instanceof HTMLInputElement) {control.type='number';control.step='any';}
        control.value=String(value);control.oninput=()=>{refreshDisabled();changed();};label.append(control);grid.append(label);
      };
      add('Mount','platform',old?.platform??'fixed',[['fixed','Fixed ground site'],['drone','On a drone']]);
      add('Host drone number','host',old?.host_index??0,Array.from({length:5},(_,i)=>[String(i),`Drone ${i+1}`]));
      add('Latitude','lat',old?.lat??Math.min(bounds[3],Math.max(bounds[1],46.48+index*.001)));
      add('Longitude','lon',old?.lon??Math.min(bounds[2],Math.max(bounds[0],30.60+index*.001)));
      add('Heading / offset (°)','heading',old?.heading_deg??90);add('Pitch (°)','pitch',old?.pitch_deg??10);
      const button=document.createElement('button');button.type='button';button.dataset.place='';button.className='wide';button.textContent=`Place CAM${index+1} on map`;
      button.onclick=()=>place(`CAM${index+1}`,(lat,lon)=>{
        (section.querySelector('[data-lat]') as HTMLInputElement).value=String(lat);
        (section.querySelector('[data-lon]') as HTMLInputElement).value=String(lon);changed();
      });grid.append(button);
      container.append(section);
    }
    refreshDisabled();
  }
  function refreshDisabled() {
    for(const row of document.querySelectorAll<HTMLElement>('[data-camera]')) {
      const moving=(row.querySelector('[data-platform]') as HTMLSelectElement).value==='drone';
      (row.querySelector('[data-host]') as HTMLSelectElement).disabled=!moving;
      (row.querySelector('[data-place]') as HTMLButtonElement).disabled=moving;
      for(const coordinate of ['lat','lon']) (row.querySelector(`[data-${coordinate}]`) as HTMLInputElement).disabled=moving;
    }
  }
  input('camera-count').onchange=()=>{render();changed();};input('satellite-count').onchange=changed;
  input('image-interval').oninput=changed;
  input('camera-placement').onchange=()=>{(document.getElementById('randomize-cameras') as HTMLButtonElement).disabled=input('camera-placement').value!=='random';};
  document.getElementById('randomize-cameras')!.onclick=()=>{
    changed();
    try {
      const seed=input('placement-seed').valueAsNumber;
      if(!Number.isInteger(seed)||seed<0||seed>0xffffffff) throw new Error('Choose a valid placement seed');
      const random=mulberry32((seed^0xcafe)>>>0);
      for(const row of document.querySelectorAll<HTMLElement>('[data-camera]')) {
        if((row.querySelector('[data-platform]') as HTMLSelectElement).value!=='fixed') continue;
        let placed=false;
        for(let attempt=0;attempt<1000;attempt++) {
          const lon=bounds[0]+(bounds[2]-bounds[0])*random(),lat=bounds[1]+(bounds[3]-bounds[1])*random();
          if(sample(Cartographic.fromDegrees(lon,lat))===undefined) continue;
          (row.querySelector('[data-lat]') as HTMLInputElement).value=String(lat);
          (row.querySelector('[data-lon]') as HTMLInputElement).value=String(lon);placed=true;break;
        }
        if(!placed) throw new Error('Could not place camera inside terrain coverage');
      }
    } catch(error) {document.getElementById('optional-status')!.textContent=(error as Error).message;}
  };
  return {read:(flights:Flight[]):OptionalConfig=>{
    const count=input('camera-count').valueAsNumber,satellite_count=input('satellite-count').valueAsNumber,interval_s=input('image-interval').valueAsNumber;
    if(!Number.isInteger(count)||count<0||count>5||!Number.isInteger(satellite_count)||satellite_count<0||satellite_count>3||!Number.isFinite(interval_s)||interval_s<=0) throw new Error('Choose 0–5 cameras, 0–3 satellite sources, and a positive image interval');
    const rows=cameras();if(rows.length!==count) throw new Error('Camera controls do not match the requested count');
    return {satellite_count,interval_s,cameras:rows.map(({host_index,...camera})=>{
      if(camera.platform==='drone'&&!flights[host_index]) throw new Error(`${camera.id}: host drone ${host_index+1} is not in this scenario`);
      if(![camera.lat,camera.lon,camera.heading_deg,camera.pitch_deg].every(Number.isFinite)||Math.abs(camera.pitch_deg)>=90||Math.abs(camera.lat)>90||Math.abs(camera.lon)>180) throw new Error(`Invalid ${camera.id} position or orientation`);
      return {...camera,...(camera.platform==='drone'?{host_object_id:flights[host_index]!.objectId}:{})};
    })};
  }};
}

/** Ideal pinhole frames for visualization; synthetic pixel geometry, no trained detector. */
export function generateOptionalSensors(
  config:OptionalConfig,flights:Flight[],sample:(point:Cartographic)=>number|undefined,
  context:{data_uri:string;bounds:CropBounds;attribution:string;source_id:string;width_px?:number;height_px?:number;source_pixel_size_degrees?:number[]},
) {
  const first=flights[0]!.trajectory;
  const frames:Array<{id:string;sensor_id:string;timestamp_s:number;timestamp_utc:string;camera_pose:{lat:number;lon:number;hae_m:number;heading_deg:number;pitch_deg:number};detections:Array<{id:string;pixel_x:number;pixel_y:number;size_px:number;confidence:number}>;svg:string}>=[];
  const associations:Array<{record_id:string;source_object_ids:string[]}>=[];
  const assets:Record<string,unknown>={};
  const satelliteImages:Array<{id:string;sensor_id:string;timestamp_s:number;timestamp_utc:string;asset_id:string;product_kind:string;optical_acquisition_time:null;objects_detected:string[]}>=[];
  for(const camera of config.cameras) {
    const host=flights.find(flight=>flight.objectId===camera.host_object_id);
    if(camera.platform==='drone'&&!host) throw new Error(`${camera.id}: missing host drone`);
    if(camera.platform==='fixed'&&sample(Cartographic.fromDegrees(camera.lon,camera.lat))===undefined) throw new Error(`${camera.id}: fixed site outside terrain coverage`);
    let nextTime=0;
    for(const [index,point] of first.ground_truth.entries()) {
      if(point.timestamp_s+1e-9<nextTime) continue;
      nextTime=point.timestamp_s+config.interval_s;
      const source=host?.trajectory.ground_truth[index];
      const lon=source?.lon??camera.lon,lat=source?.lat??camera.lat;
      const ground=sample(Cartographic.fromDegrees(lon,lat));
      if(ground===undefined) throw new Error(`${camera.id}: missing camera terrain`);
      const hae=source?source.hae_m+1:ground+camera.height_agl_m;
      const origin=Cartesian3.fromDegrees(lon,lat,hae),inverse=Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(origin),new Matrix4());
      const heading=camera.heading_deg+(host?.states[index]?.heading_deg??0),yaw=CMath.toRadians(heading),pitch=CMath.toRadians(camera.pitch_deg);
      const focal=camera.width_px/(2*Math.tan(CMath.toRadians(camera.horizontal_fov_deg)/2));
      const detections:Array<{id:string;pixel_x:number;pixel_y:number;size_px:number;confidence:number}>=[];
      const visibleIds:string[]=[];
      for(const flight of flights) {
        if(flight===host) continue;
        const target=flight.trajectory.ground_truth[index]!;
        const targetWorld=Cartesian3.fromDegrees(target.lon,target.lat,target.hae_m);
        const local=Matrix4.multiplyByPoint(inverse,targetWorld,new Cartesian3());
        const forward=Math.sin(yaw)*local.x+Math.cos(yaw)*local.y,right=Math.cos(yaw)*local.x-Math.sin(yaw)*local.y;
        const depth=Math.cos(pitch)*forward+Math.sin(pitch)*local.z,up=-Math.sin(pitch)*forward+Math.cos(pitch)*local.z;
        if(depth<=0) continue;
        const x=camera.width_px/2+focal*right/depth,y=camera.height_px/2-focal*up/depth;
        if(x<0||x>=camera.width_px||y<0||y>=camera.height_px) continue;
        let blocked=false;
        const steps=Math.min(512,Math.max(20,Math.ceil(Cartesian3.distance(origin,targetWorld)/50)));
        for(let step=1;step<steps;step++) {
          const ray=Cartographic.fromCartesian(Cartesian3.lerp(origin,targetWorld,step/steps,new Cartesian3()));
          const height=sample(ray);if(height===undefined||height>ray.height) {blocked=true;break;}
        }
        if(blocked) continue;
        visibleIds.push(flight.objectId);
        const size=focal*2.5/depth;
        if(size<2) continue;
        detections.push({id:`${camera.id}_${index}_${detections.length}`,pixel_x:x,pixel_y:y,size_px:size,confidence:Math.min(.98,size/(size+8))});
        associations.push({record_id:detections.at(-1)!.id,source_object_ids:[flight.objectId]});
      }
      const id=`frame_${camera.id}_${index}`,utc=new Date(Date.parse(first.start_utc)+point.timestamp_s*1000).toISOString();
      const shapes=detections.map(d=>`<path d="M ${d.pixel_x-d.size_px/2} ${d.pixel_y} h ${d.size_px} M ${d.pixel_x} ${d.pixel_y-d.size_px/4} v ${d.size_px/2}" stroke="#141c25" stroke-width="1.5"/>`).join('');
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#a9b5bf"/>${shapes}<text x="30" y="45" font-family="monospace" font-size="24" fill="#152c3b">${escape(camera.id)} · ${escape(utc)} · SCHEMATIC PINHOLE FRAME</text></svg>`;
      frames.push({id,sensor_id:camera.id,timestamp_s:point.timestamp_s,timestamp_utc:utc,camera_pose:{lat,lon,hae_m:hae,heading_deg:heading,pitch_deg:camera.pitch_deg},detections,svg});
      associations.push({record_id:id,source_object_ids:visibleIds});
    }
  }
  if(config.satellite_count) assets.terrain_context={...context,product_kind:'satellite_derived_DSM_hillshade_not_optical',optical_acquisition_time:null};
  for(let sensor=0;sensor<config.satellite_count;sensor++) {
    let nextTime=0;
    for(const point of first.ground_truth) {
      if(point.timestamp_s+1e-9<nextTime) continue;
      nextTime=point.timestamp_s+config.interval_s;
      const id=`context_SAT${sensor+1}_${point.timestamp_s}`;
      satelliteImages.push({id,sensor_id:`SAT${sensor+1}`,timestamp_s:point.timestamp_s,timestamp_utc:new Date(Date.parse(first.start_utc)+point.timestamp_s*1000).toISOString(),asset_id:'terrain_context',product_kind:'static_terrain_context',optical_acquisition_time:null,objects_detected:[]});
      associations.push({record_id:id,source_object_ids:[context.source_id]});
    }
  }
  return {configuration:config,model_notes:{camera:'Ideal 1920×1080 pinhole, 20° horizontal FOV, 2.5 m target, terrain LOS, ≥2-pixel detection; schematic frames, heuristic confidence, no image noise or hardware calibration',satellite:'Shared static DSM hillshade context at scenario timestamps; no optical acquisition, orbit, or drone detection model. Additional configured sources reference the same context asset.',fusion:'Camera/satellite records are exported separately; RF fixes use RF bearings only'},camera_frames:frames,satellite_images:satelliteImages,assets,associations};
}
