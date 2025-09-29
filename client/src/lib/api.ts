export const api = {
  guards:    () => fetch("/api/guards").then(r => r.json()),
  day:       (day: string) => fetch(`/api/rotations/day/${day}`).then(r => r.json()),
  queueGet:  (day: string) => fetch(`/api/plan/queue?date=${day}`).then(r => r.json()),
  queueAdd:  (body: any) => fetch("/api/plan/queue-add",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":"dev-key-123"},body:JSON.stringify(body)}).then(r=>r.json()),
  queueClr:  (day: string) => fetch("/api/plan/queue-clear",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":"dev-key-123"},body:JSON.stringify({date:day})}).then(r=>r.json()),
  rotate:    (body: any) => fetch("/api/plan/rotate",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":"dev-key-123"},body:JSON.stringify(body)}).then(r=>r.json()),
  auto:      (body: any) => fetch("/api/plan/autopopulate",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":"dev-key-123"},body:JSON.stringify(body)}).then(r=>r.json()),
  slot:      (body: any) => fetch("/api/rotations/slot",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":"dev-key-123"},body:JSON.stringify(body)}).then(r=>r.json()),
};
