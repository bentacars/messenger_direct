// Collect image_1..image_10 (only valid URLs)
export function imageList(u) {
  const urls = [];
  for (let i=1;i<=10;i++) {
    const k = `image_${i}`;
    const v = u[k];
    if (v && /^https?:\/\//i.test(String(v))) urls.push(String(v));
  }
  return urls;
}
