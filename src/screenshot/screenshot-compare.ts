import type * as d from '@stencil/core/internal';
import { normalizePath } from '@utils';
import { fork } from 'child_process';
import { createHash } from 'crypto';
import { join, relative } from 'path';

import { writeScreenshotData, writeScreenshotImage } from './screenshot-fs';

export async function compareScreenshot(
  emulateConfig: d.EmulateConfig,
  screenshotBuildData: d.ScreenshotBuildData,
  currentScreenshotBuf: Buffer,
  desc: string,
  width: number,
  height: number,
  testPath: string,
  pixelmatchThreshold: number,
) {
  const currentImageHash = createHash('md5').update(currentScreenshotBuf).digest('hex');
  const currentImageName = `${currentImageHash}.png`;
  const currentImagePath = join(screenshotBuildData.imagesDir, currentImageName);

  await writeScreenshotImage(currentImagePath, currentScreenshotBuf);
  currentScreenshotBuf = null;

  if (testPath) {
    testPath = normalizePath(relative(screenshotBuildData.rootDir, testPath));
  }

  // create the data we'll be saving as json
  // the "id" is what we use as a key to compare to sets of data
  // the "image" is a hash of the image file name
  // and what we can use to quickly see if they're identical or not
  const screenshotId = getScreenshotId(emulateConfig, desc);

  const screenshot = {
    id: screenshotId,
    image: currentImageName,
    device: emulateConfig.device,
    userAgent: emulateConfig.userAgent,
    desc: desc,
    testPath: testPath,
    width: width,
    height: height,
    deviceScaleFactor: emulateConfig.viewport?.deviceScaleFactor,
    hasTouch: emulateConfig.viewport?.hasTouch,
    isLandscape: emulateConfig.viewport?.isLandscape,
    isMobile: emulateConfig.viewport?.isMobile,
    diff: {
      id: screenshotId,
      desc: desc,
      imageA: currentImageName,
      imageB: currentImageName,
      mismatchedPixels: 0,
      device: emulateConfig.device,
      userAgent: emulateConfig.userAgent,
      width: width,
      height: height,
      deviceScaleFactor: emulateConfig.viewport?.deviceScaleFactor,
      hasTouch: emulateConfig.viewport?.hasTouch,
      isLandscape: emulateConfig.viewport?.isLandscape,
      isMobile: emulateConfig.viewport?.isMobile,
      allowableMismatchedPixels: screenshotBuildData.allowableMismatchedPixels,
      allowableMismatchedRatio: screenshotBuildData.allowableMismatchedRatio,
      testPath: testPath,
      cacheKey: undefined as string | undefined,
    },
  } satisfies d.Screenshot;

  if (screenshotBuildData.updateMaster) {
    // this data is going to become the master data
    // so no need to compare with previous versions
    await writeScreenshotData(screenshotBuildData.currentBuildDir, screenshot);
    return screenshot.diff;
  }

  const masterScreenshotImage = screenshotBuildData.masterScreenshots[screenshot.id];

  if (!masterScreenshotImage) {
    // didn't find a master screenshot to compare it to
    await writeScreenshotData(screenshotBuildData.currentBuildDir, screenshot);
    return screenshot.diff;
  }

  // set that the master data image as the image we're going to compare the current image to
  // imageB is already set as the current image
  screenshot.diff.imageA = masterScreenshotImage;

  // compare only if the image hashes are different
  if (screenshot.diff.imageA !== screenshot.diff.imageB) {
    // we know the images are not identical since they have different hashes
    // create a cache key from the two hashes
    screenshot.diff.cacheKey = getCacheKey(screenshot.diff.imageA, screenshot.diff.imageB, pixelmatchThreshold);

    // let's see if we've already calculated the mismatched pixels already
    const cachedMismatchedPixels = screenshotBuildData.cache[screenshot.diff.cacheKey];
    if (typeof cachedMismatchedPixels === 'number' && !isNaN(cachedMismatchedPixels)) {
      // awesome, we've got cached data so we
      // can skip having to do the heavy pixelmatch comparison
      screenshot.diff.mismatchedPixels = cachedMismatchedPixels;
    } else {
      // images are not identical
      // and we don't have any cached data so let's
      // compare the two images pixel by pixel to
      // figure out a mismatch value

      // figure out the actual width and height of the screenshot
      const naturalWidth = Math.round(emulateConfig.viewport.width * emulateConfig.viewport.deviceScaleFactor);
      const naturalHeight = Math.round(emulateConfig.viewport.height * emulateConfig.viewport.deviceScaleFactor);

      const pixelMatchInput: d.PixelMatchInput = {
        imageAPath: join(screenshotBuildData.imagesDir, screenshot.diff.imageA),
        imageBPath: join(screenshotBuildData.imagesDir, screenshot.diff.imageB),
        width: naturalWidth,
        height: naturalHeight,
        pixelmatchThreshold: pixelmatchThreshold,
      };

      screenshot.diff.mismatchedPixels = await getMismatchedPixels(
        screenshotBuildData.pixelmatchModulePath,
        pixelMatchInput,
      );
    }
  }

  await writeScreenshotData(screenshotBuildData.currentBuildDir, screenshot);

  return screenshot.diff;
}

async function getMismatchedPixels(pixelmatchModulePath: string, pixelMatchInput: d.PixelMatchInput) {
  return new Promise<number>((resolve, reject) => {
    /**
     * When using screenshot functionality in a runner that is not Jasmine (e.g. Jest Circus), we need to set a default
     * value for timeouts. There are runtime errors that occur if we attempt to use optional chaining + nullish
     * coalescing with the `jasmine` global stating it's not defined. As a result, we use a ternary here.
     *
     * The '2500' value that we default to is the value of `jasmine.DEFAULT_TIMEOUT_INTERVAL` (5000) divided by 2.
     */
    const timeout =
      typeof jasmine !== 'undefined' && jasmine.DEFAULT_TIMEOUT_INTERVAL
        ? jasmine.DEFAULT_TIMEOUT_INTERVAL * 0.5
        : 2500;
    const tmr = setTimeout(() => {
      reject(`getMismatchedPixels timeout: ${timeout}ms`);
    }, timeout);

    try {
      const filteredExecArgs = process.execArgv.filter((v) => !/^--(debug|inspect)/.test(v));

      const options = {
        execArgv: filteredExecArgs,
        env: process.env,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as any,
      };

      const pixelMatchProcess = fork(pixelmatchModulePath, [], options);

      pixelMatchProcess.on('message', (data: any) => {
        pixelMatchProcess.kill();
        clearTimeout(tmr);
        resolve(data);
      });

      pixelMatchProcess.on('error', (err) => {
        clearTimeout(tmr);
        reject(err);
      });

      pixelMatchProcess.send(pixelMatchInput);
    } catch (e) {
      clearTimeout(tmr);
      reject(`getMismatchedPixels error: ${e}`);
    }
  });
}

function getCacheKey(imageA: string, imageB: string, pixelmatchThreshold: number) {
  const hash = createHash('md5');
  hash.update(`${imageA}:${imageB}:${pixelmatchThreshold}`);
  return hash.digest('hex').slice(0, 10);
}

function getScreenshotId(emulateConfig: d.EmulateConfig, uniqueDescription: string) {
  if (typeof uniqueDescription !== 'string' || uniqueDescription.trim().length === 0) {
    throw new Error(`invalid test description`);
  }

  const hash = createHash('md5');

  hash.update(uniqueDescription + ':');
  hash.update(emulateConfig.userAgent + ':');

  if (emulateConfig.viewport !== undefined) {
    hash.update(emulateConfig.viewport.width + ':');
    hash.update(emulateConfig.viewport.height + ':');
    hash.update(emulateConfig.viewport.deviceScaleFactor + ':');
    hash.update(emulateConfig.viewport.hasTouch + ':');
    hash.update(emulateConfig.viewport.isMobile + ':');
  }

  return hash.digest('hex').slice(0, 8).toLowerCase();
}
