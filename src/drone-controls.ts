import type { CropBounds } from './scenario-config';

export function droneControls(bounds: CropBounds) {
  const number=(id:string)=>(document.getElementById(id) as HTMLInputElement).valueAsNumber;
  function read() {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-drone-start]'),row=>({
      object_id:(row.querySelector('[data-object]') as HTMLInputElement).value.trim(),
      longitude_deg:(row.querySelector('[data-lon]') as HTMLInputElement).valueAsNumber,
      latitude_deg:(row.querySelector('[data-lat]') as HTMLInputElement).valueAsNumber,
      heading_deg:(row.querySelector('[data-heading]') as HTMLInputElement).valueAsNumber,
    }));
  }
  function render() {
    const count=number('drone-count'),existing=read(),container=document.getElementById('drone-starts')!;
    if(!Number.isInteger(count)||count<1||count>5) return;
    if(container.children.length===count-1) return;
    container.replaceChildren();
    for(let index=0;index<count-1;index++) {
      const initial=existing[index]??{
        object_id:`${(document.getElementById('input-object') as HTMLInputElement).value}_${index+2}`,
        longitude_deg:number('input-lon')+.002*(index+1),latitude_deg:number('input-lat')+.001*(index+1),heading_deg:number('input-heading'),
      };
      const section=document.createElement('div');section.dataset.droneStart=String(index+2);section.className='drone-start';
      const title=document.createElement('strong');title.textContent=`Drone ${index+2}`;section.append(title);
      const grid=document.createElement('div');grid.className='form-grid';section.append(grid);
      for(const [key,labelText,data,min,max] of [
        ['object_id','Object ID','object',undefined,undefined],
        ['longitude_deg','Start longitude','lon',bounds[0],bounds[2]],
        ['latitude_deg','Start latitude','lat',bounds[1],bounds[3]],
        ['heading_deg','Heading (°)','heading',0,359.999],
      ] as const) {
        const label=document.createElement('label');label.className='field';label.textContent=labelText;
        const input=document.createElement('input');input.dataset[data]='';input.type=key==='object_id'?'text':'number';input.step='any';input.required=true;
        if(min!==undefined) input.min=String(min);if(max!==undefined) input.max=String(max);
        input.value=String(initial[key]);label.append(input);grid.append(label);
      }
      container.append(section);
    }
  }
  document.getElementById('drone-count')!.addEventListener('change',render);
  return {read};
}
