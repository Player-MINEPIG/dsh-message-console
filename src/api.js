export async function request(path, body, {signal}={}) {
  const response = await fetch(`/api/dsh-message-console/${path}`, { credentials: 'same-origin', signal, ...(body === undefined ? {} : { method:'POST', headers: { 'Content-Type':'application/json', 'X-DSH-Message-Console':'1' }, body:JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '请求失败');
  return value;
}
