import { Cartographic, EllipsoidGeodesic } from 'cesium';
import { mulberry32 } from './math';
import type { SensorGeneratorConfig } from './sensor-generator';

export type CropBounds = readonly [number,number,number,number];

/** Uniform placement inside the original sample-center crop; no geometry optimization. */
export function randomReceiverSites(
  template: SensorGeneratorConfig['receivers'][number], count: number, seed: number,
  bounds: CropBounds, sample: (point: Cartographic)=>number|undefined,
): SensorGeneratorConfig['receivers'] {
  if (!Number.isInteger(count) || count<0 || count>12) throw new Error('Choose 0–12 RF receivers');
  if (!Number.isInteger(seed) || seed<0 || seed>0xffffffff) throw new Error('Placement seed must be an unsigned 32-bit integer');
  const random=mulberry32(seed),[west,south,east,north]=bounds;
  const result: SensorGeneratorConfig['receivers']=[];
  for (let index=0;index<count;index++) {
    let placed=false;
    for (let attempt=0;attempt<1000;attempt++) {
      const lon=west+(east-west)*random(),lat=south+(north-south)*random();
      const point=Cartographic.fromDegrees(lon,lat);
      const height=sample(point);
      if (height===undefined || !Number.isFinite(height)) continue;
      if (result.some(site=>new EllipsoidGeodesic(point,Cartographic.fromDegrees(site.lon!,site.lat!)).surfaceDistance<20)) continue;
      const {x_m: _x,y_m: _y,...base}=template;
      result.push({...base,uid:`RF${index+1}`,callsign:`RF array ${index+1}`,lat,lon});
      placed=true;break;
    }
    if (!placed) throw new Error('Could not place all receivers within terrain coverage');
  }
  return result;
}
