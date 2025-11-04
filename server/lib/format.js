export function titleLine(u){
  const yr = u.year ? `${u.year} ` : '';
  const v  = u.variant ? ` ${u.variant}` : '';
  const tx = u.transmission ? ` ${u.transmission}` : '';
  return `${yr}${u.brand||''} ${u.model||''}${v}${tx}`.replace(/\s+/g,' ').trim();
}

export function subLine(u){
  const km = u.mileage ? `${Number(u.mileage).toLocaleString('en-PH')} km` : '';
  const loc = [u.city, u.province].filter(Boolean).join(', ');
  const fuel = u.fuel_type || '';
  return [km, loc, fuel].filter(Boolean).join(' — ');
}
