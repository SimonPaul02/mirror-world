import type { Cartographic } from 'cesium';
import { randomReceiverSites, type CropBounds } from './scenario-config';
import type { SensorGeneratorConfig } from './sensor-generator';

export function receiverControls(defaults: SensorGeneratorConfig, bounds: CropBounds, sample: (point: Cartographic)=>number|undefined, changed: ()=>void,place:(label:string,placed:(lat:number,lon:number)=>void)=>void) {
  const element=(id:string)=>document.getElementById(id) as HTMLInputElement;
  let sites=structuredClone(defaults.receivers);
  const read=()=>{
    const count=element('rf-count').valueAsNumber;
    if(!Number.isInteger(count)||count<0||count>12||count!==sites.length) throw new Error('Choose 0–12 RF receivers');
    return sites.map((site,index)=>({...site,lat:element(`rf${index+1}-lat`).valueAsNumber,lon:element(`rf${index+1}-lon`).valueAsNumber}));
  };
  function render() {
    const container=document.getElementById('rf-sites')!;
    container.replaceChildren();
    for (const [index,site] of sites.entries()) {
      for (const coordinate of ['lat','lon'] as const) {
        const label=document.createElement('label');label.className='field';
        label.textContent=`RF${index+1} ${coordinate==='lat'?'latitude':'longitude'}`;
        const input=document.createElement('input');input.type='number';input.step='any';
        input.id=`rf${index+1}-${coordinate}`;input.value=String(site[coordinate]);
        input.oninput=changed;label.append(input);container.append(label);
      }
      const button=document.createElement('button');button.type='button';button.className='wide';button.textContent=`Place RF${index+1} on map`;
      button.onclick=()=>place(`RF${index+1}`,(lat,lon)=>{element(`rf${index+1}-lat`).value=String(lat);element(`rf${index+1}-lon`).value=String(lon);changed();});container.append(button);
    }
  }
  element('rf-count').onchange=()=>{
    const count=element('rf-count').valueAsNumber;
    try {
      if(!Number.isInteger(count)||count<0||count>12) throw new Error('Choose 0–12 RF receivers');
      if(count===sites.length) return;
      const candidates=Array.from({length:count},(_,index)=>defaults.receivers[index]??{
        ...defaults.receivers[0]!,uid:`RF${index+1}`,callsign:`RF array ${index+1}`,
        lon:bounds[0]+(bounds[2]-bounds[0])*((index%3)+1)/4,
        lat:bounds[1]+(bounds[3]-bounds[1])*(Math.floor(index/3)+1)/5,
      });
      const old=sites.map((site,index)=>({...site,lat:element(`rf${index+1}-lat`).valueAsNumber,lon:element(`rf${index+1}-lon`).valueAsNumber}));sites=candidates.map((site,index)=>old[index]??site);render();changed();
    } catch(error) {changed();document.getElementById('rf-status')!.textContent=(error as Error).message;}
  };
  element('rf-placement').onchange=()=>{(document.getElementById('randomize-rf') as HTMLButtonElement).disabled=element('rf-placement').value!=='random';};
  document.getElementById('randomize-rf')!.onclick=()=>{
    try {
      sites=randomReceiverSites(defaults.receivers[0]!,element('rf-count').valueAsNumber,element('placement-seed').valueAsNumber,bounds,sample);
      render();changed();
    } catch(error) {changed();document.getElementById('rf-status')!.textContent=(error as Error).message;}
  };
  render();return {read};
}
