/** Independent adapter pattern informed by Apple SwiftMetrics and Palantir go-baseapp.
 * See ../NOTICE. No payloads, tokens, identifiers, paths or unbounded labels are emitted.
 */
export type CounterName="stored"|"duplicate"|"dispatch_attempt"|"dispatch_failed"|"delivered"|"http_2xx"|"http_4xx"|"http_5xx"|"rate_limited";
export interface MetricsSink {count(name:CounterName,value:number):void;record(name:"request_ms",value:number):void}
export class IngestMetrics {
  readonly #counts:Record<CounterName,number>={stored:0,duplicate:0,dispatch_attempt:0,dispatch_failed:0,delivered:0,http_2xx:0,http_4xx:0,http_5xx:0,rate_limited:0};
  readonly #sink?:MetricsSink;
  constructor(sink?:MetricsSink){this.#sink=sink;}
  count(name:CounterName){this.#counts[name]=Math.min(Number.MAX_SAFE_INTEGER,this.#counts[name]+1);try{this.#sink?.count(name,1);}catch{/* Telemetry cannot invalidate a committed receipt. */}}
  duration(ms:number){if(!Number.isFinite(ms))return;try{this.#sink?.record("request_ms",Math.min(3600000,Math.max(0,ms)));}catch{/* Observer failure is isolated. */}}
  snapshot(){return {...this.#counts};}
}
/** Independent, single-process token bucket; Meta Folly source review, not its atomic C++ implementation. */
export class TokenBucket {
  #tokens:number;#last:number;readonly #rate:number;readonly #burst:number;readonly #clock:()=>number;
  constructor(rate=5,burst=10,clock=()=>performance.now()){
    if(!Number.isFinite(rate)||!Number.isFinite(burst)||rate<=0||rate>1000||burst<1||burst>1000)throw new Error("Invalid bucket limits");
    this.#rate=rate;this.#burst=burst;this.#tokens=burst;this.#clock=clock;this.#last=clock();if(!Number.isFinite(this.#last))throw new Error("Invalid bucket clock");
  }
  take(){const now=this.#clock();if(!Number.isFinite(now))return false;const elapsed=Math.max(0,now-this.#last);this.#last=Math.max(now,this.#last);this.#tokens=Math.min(this.#burst,this.#tokens+elapsed*this.#rate/1000);if(this.#tokens<1)return false;this.#tokens-=1;return true;}
}
