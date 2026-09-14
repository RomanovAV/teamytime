export function assertRuntime(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) {
    throw new Error(`Teamytime нужен Node.js 22.16.0 или новее. Сейчас: ${version}.`);
  }
}

export async function loadBuildTool() {
  assertRuntime();
  try { return await import('esbuild'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('Не установлен сборщик esbuild. Для разработки установите зависимости из разрешённого реестра: npm ci --include=dev. Для запуска без установки используйте готовый архив Teamytime.');
  }
}
