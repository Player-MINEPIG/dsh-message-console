export function imageURL(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('图片地址无效');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !/^i\d+\.hdslb\.com$/.test(url.hostname) || url.username || url.password || url.port || !url.pathname.startsWith('/bfs/')) throw new Error('图片地址不属于允许的B站图片域名');
  url.protocol = 'https:'; url.hash = '';
  return url.href;
}
export function commentImages(content) {
  if (content?.pictures == null) return {};
  if (!Array.isArray(content.pictures) || content.pictures.length > 20) throw new Error('评论图片结构无效');
  const images = content.pictures.map(picture => {
    if (!picture || typeof picture.img_src !== 'string') throw new Error('评论图片地址缺失');
    const image = { url: imageURL(picture.img_src) };
    for (const [from, to] of [['img_width', 'width'], ['img_height', 'height'], ['img_size', 'sizeKB']]) {
      const value = picture[from];
      if (value != null) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('评论图片尺寸无效');
        image[to] = value;
      }
    }
    return image;
  });
  return images.length ? { images } : {};
}
export const containsImages = item => Boolean(item?.payload?.images?.length || item?.payload?.comments?.some(comment => comment.images?.length));
