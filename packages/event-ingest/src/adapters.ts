/** Independent, offline diagnostic normalization informed by DJI MIT topic DTOs.
 * No MQTT subscription, device login, command/reply handler or vehicle-control transport.
 * Attribution and unmodified MIT license in ../NOTICE and ../licenses/.
 */
import { archiveEvent,digest,fail,identifier,object } from "./schema.ts";
import type { Dispatcher } from "./service.ts";
export function djiDiagnosticEvent(topic:string,raw:Uint8Array,expectedSerial:string) {
  identifier(expectedSerial);
  if(topic!==`thing/product/${expectedSerial}/osd`||raw.byteLength>65536)return fail("invalid","Unsupported diagnostic topic or payload");
  let envelope:Record<string,unknown>;
  try{envelope=object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)));}catch{return fail("invalid","Invalid diagnostic JSON");}
  identifier(envelope.tid);identifier(envelope.bid);
  if(!Number.isSafeInteger(envelope.timestamp)||Number(envelope.timestamp)<946684800000||Number(envelope.timestamp)>4102444800000)return fail("invalid","Invalid diagnostic timestamp");
  const data=object(envelope.data),measurements:Record<string,number|boolean>={};
  for(const [field,name,min,max] of [["temperature","temperatureC",-80,150],["environment_temperature","environmentTemperatureC",-80,150],["humidity","humidityPct",0,100]] as const){
    if(Object.hasOwn(data,field)){const value=data[field];if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max)return fail("invalid","Invalid diagnostic measurement");measurements[name]=value;}
  }
  if(Object.hasOwn(data,"drone_in_dock")){if(typeof data.drone_in_dock!=="boolean")return fail("invalid","Invalid dock flag");measurements.droneInDock=data.drone_in_dock;}
  if(!Object.keys(measurements).length)return fail("invalid","No supported diagnostic fields");
  return archiveEvent({id:digest({serial:expectedSerial,tid:envelope.tid,bid:envelope.bid,timestamp:envelope.timestamp}),kind:"diagnostic",observedAt:new Date(Number(envelope.timestamp)).toISOString(),payload:{format:"dji-osd-diagnostics-v1",serial:expectedSerial,measurements}});
}
/** Publisher must resolve only after broker acknowledgement; this package does not impersonate MQTT QoS. */
export interface MqttPublisher {publish(topic:string,bytes:Uint8Array,options:{qos:1;retain:false;signal:AbortSignal}):Promise<void>}
export function mqttArchiveDispatcher(publisher:MqttPublisher,topic:string):Dispatcher {
  if(!/^archives\/[a-zA-Z0-9][a-zA-Z0-9/_-]{0,118}$/.test(topic))throw new Error("Fixed MQTT archive topic required");
  return {send:async(event,idempotencyKey,signal)=>{signal.throwIfAborted();await publisher.publish(topic,Buffer.from(JSON.stringify({idempotencyKey,event})),{qos:1,retain:false,signal});}};
}
export function httpArchiveDispatcher(endpoint:string,fetcher:typeof fetch=fetch):Dispatcher {
  const url=new URL(endpoint);if(url.protocol!=="https:"||url.username||url.password||url.hash||url.search)throw new Error("Fixed HTTPS archive endpoint required");
  return {send:async(event,idempotencyKey,signal)=>{
    const response=await fetcher(url,{method:"POST",headers:{"content-type":"application/json","idempotency-key":idempotencyKey},body:JSON.stringify(event),redirect:"error",cache:"no-store",signal});
    // Never include downstream response bodies/URLs in errors or read an unbounded response body.
    await response.body?.cancel();if(!response.ok)throw new Error("Archive dispatcher denied");
  }};
}
