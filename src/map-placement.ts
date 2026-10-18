import { Cartesian3, Cartographic, Color, Math as CMath, ScreenSpaceEventHandler, ScreenSpaceEventType, type Cartesian2, type Viewer } from 'cesium';

export function mapPlacement(viewer:Viewer,sample:(point:Cartographic)=>number|undefined) {
  const handler=new ScreenSpaceEventHandler(viewer.scene.canvas);
  const status=document.getElementById('placement-status')!,text=document.getElementById('placement-status-text')!;
  let active=false;
  const clearPreview=()=>viewer.entities.removeById('sensor-placement-preview');
  const cancel=()=>{active=false;handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);status.hidden=true;viewer.scene.canvas.style.cursor='';};
  document.getElementById('cancel-placement')!.onclick=()=>{cancel();clearPreview();};
  const keydown=(event:KeyboardEvent)=>{if(active&&event.key==='Escape') {cancel();clearPreview();}};
  document.addEventListener('keydown',keydown);
  return {
    start:(label:string,placed:(lat:number,lon:number)=>void)=>{
      cancel();clearPreview();active=true;status.hidden=false;text.textContent=`Click inside the terrain crop to place ${label}.`;
      viewer.scene.canvas.style.cursor='crosshair';
      handler.setInputAction((event:{position:Cartesian2})=>{
        const ray=viewer.camera.getPickRay(event.position),world=ray?viewer.scene.globe.pick(ray,viewer.scene):undefined;
        if(!world) return;
        const point=Cartographic.fromCartesian(world),height=sample(point);
        if(height===undefined) {text.textContent=`Place ${label} inside the terrain crop.`;return;}
        const lat=CMath.toDegrees(point.latitude),lon=CMath.toDegrees(point.longitude);
        cancel();placed(lat,lon);
        viewer.entities.add({id:'sensor-placement-preview',position:Cartesian3.fromDegrees(lon,lat,height+1),point:{pixelSize:10,color:Color.WHITE,outlineColor:Color.CYAN,outlineWidth:2,disableDepthTestDistance:Number.POSITIVE_INFINITY}});
      },ScreenSpaceEventType.LEFT_CLICK);
    },
    cancel:()=>{cancel();clearPreview();},clearPreview,
    destroy:()=>{cancel();clearPreview();handler.destroy();document.removeEventListener('keydown',keydown);},
  };
}
