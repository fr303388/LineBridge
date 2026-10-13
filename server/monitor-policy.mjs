// Talk sync is a long poll. Its transport deadline is independent of the
// freshness required to report a healthy receiver; waiting never renews success.
export const TALK_POLL_TIMEOUT_MS=180000;
export const MONITOR_STALE_AFTER_MS=60000;
export const DEFAULT_REFRESH_INTERVAL_SECONDS=15;
export const TALK_REARM_MS=250;
// LINE may end an idle Talk long poll early with an empty HTTP 410 (observed
// after about 110 seconds). Only a held request can be such an idle expiry; a
// quick 410 stays a failure.
export const TALK_IDLE_EXPIRY_MIN_MS=20000;
export function talkRearmDelayMs(fastEmptyCount){return fastEmptyCount<2?TALK_REARM_MS:Math.min(5000,1000*2**Math.min(3,fastEmptyCount-2));}
export const MIN_REFRESH_INTERVAL_SECONDS=3;
export const MAX_REFRESH_INTERVAL_SECONDS=3600;
export const SQUARE_CONCURRENCY=2;
export const SQUARE_RECONCILE_MS=300000;

// Positive bounded jitter avoids synchronized account retries; never retry before
// a server's bounded Retry-After. No delay here implies an upstream quota claim.
export function monitorRetryMs(attempt,retryAfterMs=0,random=Math.random){
  const base=Math.min(25000,2000*2**Math.min(attempt,4));
  return Math.max(Math.min(300000,Math.max(0,retryAfterMs)),Math.min(30000,Math.round(base*(1+0.2*random()))));
}

export function refreshIntervalSeconds(store){
  const value=store.setting('messageRefreshIntervalSeconds',DEFAULT_REFRESH_INTERVAL_SECONDS);
  return Number.isInteger(value)&&value>=MIN_REFRESH_INTERVAL_SECONDS&&value<=MAX_REFRESH_INTERVAL_SECONDS?value:DEFAULT_REFRESH_INTERVAL_SECONDS;
}
