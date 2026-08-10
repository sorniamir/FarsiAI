import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';

export async function saveGeneratedImage(dataUrl: string): Promise<void> {
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!match) throw new Error('فرمت تصویر برای دانلود معتبر نیست.');
  const extension = match[1].startsWith('jp') ? 'jpg' : match[1];
  const uri = `${FileSystem.cacheDirectory}farsiai-${Date.now()}.${extension}`;
  await FileSystem.writeAsStringAsync(uri, match[2], { encoding: FileSystem.EncodingType.Base64 });
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (permission.status !== 'granted') throw new Error('اجازه ذخیره تصویر در گالری داده نشد.');
  await MediaLibrary.saveToLibraryAsync(uri);
}
