/*
 * Copyright (c) 2017 American Express Travel Related Services Company, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */
/* eslint-disable no-underscore-dangle */
const kebabCase = require('lodash/kebabCase');
const merge = require('lodash/merge');
const path = require('path');
const Chalk = require('chalk').Instance;
const { diffImageToSnapshot, runDiffImageToSnapshot } = require('./diff-snapshot');
const fs = require('fs');
const childProc = require('child_process');
const OutdatedSnapshotReporter = require('./outdated-snapshot-reporter');
const notifier = require('node-notifier');
const { Confirm } = require('enquirer');

const timesCalled = new Map();

const SNAPSHOTS_DIR = '__image_snapshots__';
const DIFF_DIR = '__diff_output';
const RECEIVED_DIR = '__received_snapshots__';

function updateSnapshotState(originalSnapshotState, partialSnapshotState) {
  if (global.UNSTABLE_SKIP_REPORTING) {
    return originalSnapshotState;
  }
  return merge(originalSnapshotState, partialSnapshotState);
}

function checkResult({
  result,
  snapshotState,
  retryTimes,
  snapshotIdentifier,
  chalk,
  dumpDiffToConsole,
  dumpInlineDiffToConsole,
  allowSizeMismatch,
}) {
  let pass = true;
  /*
    istanbul ignore next
    `message` is implementation detail. Actual behavior is tested in integration.spec.js
  */
  let message = () => '';

  if (result.updated) {
    // once transition away from jasmine is done this will be a lot more elegant and pure
    // https://github.com/facebook/jest/pull/3668
    updateSnapshotState(snapshotState, { updated: snapshotState.updated + 1 });
  } else if (result.added) {
    updateSnapshotState(snapshotState, { added: snapshotState.added + 1 });
  } else {
    ({ pass } = result);

    if (pass) {
      updateSnapshotState(snapshotState, { matched: snapshotState.matched + 1 });
    } else {
      const currentRun = timesCalled.get(snapshotIdentifier);
      if (!retryTimes || (currentRun > retryTimes)) {
        updateSnapshotState(snapshotState, { unmatched: snapshotState.unmatched + 1 });
      }

      const differencePercentage = result.diffRatio * 100;
      message = () => {
        let failure;
        if (result.diffSize && !allowSizeMismatch) {
          failure = `Expected image to be the same size as the snapshot (${result.imageDimensions.baselineWidth}x${result.imageDimensions.baselineHeight}), but was different (${result.imageDimensions.receivedWidth}x${result.imageDimensions.receivedHeight}).\n`;
        } else {
          failure = `Expected image to match or be a close match to snapshot but was ${differencePercentage}% different from snapshot (${result.diffPixelCount} differing pixels).\n`;
        }

        failure += `${chalk.bold.red('See diff for details:')} ${chalk.red(result.diffOutputPath)}`;

        const supportedInlineTerms = [
          'iTerm.app',
          'WezTerm',
        ];

        if (dumpInlineDiffToConsole && (supportedInlineTerms.includes(process.env.TERM_PROGRAM) || 'ENABLE_INLINE_DIFF' in process.env)) {
          failure += `\n\n\t\x1b]1337;File=name=${Buffer.from(result.diffOutputPath).toString('base64')};inline=1;width=40:${result.imgSrcString.replace('data:image/png;base64,', '')}\x07\x1b\n\n`;
        } else if (dumpDiffToConsole || dumpInlineDiffToConsole) {
          failure += `\n${chalk.bold.red('Or paste below image diff string to your browser`s URL bar.')}\n ${result.imgSrcString}`;
        }

        return failure;
      };
    }
  }

  return {
    message,
    pass,
  };
}

function createSnapshotIdentifier({
  retryTimes,
  testPath,
  currentTestName,
  customSnapshotIdentifier,
  snapshotState,
}) {
  const counter = snapshotState._counters.get(currentTestName);
  const dirName = currentTestName.split('...');
  const itTitle = dirName[1];
  const defaultIdentifier = kebabCase(`${path.basename(testPath)}-${currentTestName}-${counter}`);

  let snapshotIdentifier = customSnapshotIdentifier || `${itTitle}-snap`;

  if (typeof customSnapshotIdentifier === 'function') {
    const customRes = customSnapshotIdentifier({
      testPath, currentTestName, counter, defaultIdentifier,
    });

    if (retryTimes && !customRes) {
      throw new Error('A unique customSnapshotIdentifier must be set when jest.retryTimes() is used');
    }

    snapshotIdentifier = customRes || defaultIdentifier;
  }

  if (retryTimes) {
    if (!customSnapshotIdentifier) throw new Error('A unique customSnapshotIdentifier must be set when jest.retryTimes() is used');

    timesCalled.set(snapshotIdentifier, (timesCalled.get(snapshotIdentifier) || 0) + 1);
  }

  return snapshotIdentifier;
}

function configureToMatchImageSnapshot({
  customDiffConfig: commonCustomDiffConfig = {},
  customSnapshotIdentifier: commonCustomSnapshotIdentifier,
  customSnapshotsDir: commonCustomSnapshotsDir,
  storeReceivedOnFailure: commonStoreReceivedOnFailure = true,
  customReceivedDir: commonCustomReceivedDir,
  customReceivedPostfix: commonCustomReceivedPostfix = '-received',
  customDiffDir: commonCustomDiffDir,
  onlyDiff: commonOnlyDiff = false,
  diffDirection: commonDiffDirection = 'horizontal',
  noColors: commonNoColors,
  failureThreshold: commonFailureThreshold = 0,
  failureThresholdType: commonFailureThresholdType = 'pixel',
  updatePassedSnapshot: commonUpdatePassedSnapshot = false,
  blur: commonBlur = 0,
  runInProcess: commonRunInProcess = false,
  dumpDiffToConsole: commonDumpDiffToConsole = false,
  dumpInlineDiffToConsole: commonDumpInlineDiffToConsole = false,
  allowSizeMismatch: commonAllowSizeMismatch = false,
  comparisonMethod: commonComparisonMethod = 'pixelmatch',
} = {}) {
  return async function toMatchImageSnapshot(received, {
    customSnapshotIdentifier = commonCustomSnapshotIdentifier,
    customSnapshotsDir = commonCustomSnapshotsDir,
    storeReceivedOnFailure = commonStoreReceivedOnFailure,
    customReceivedDir = commonCustomReceivedDir,
    customReceivedPostfix = commonCustomReceivedPostfix,
    customDiffDir = commonCustomDiffDir,
    onlyDiff = commonOnlyDiff,
    diffDirection = commonDiffDirection,
    customDiffConfig = {},
    noColors = commonNoColors,
    failureThreshold = commonFailureThreshold,
    failureThresholdType = commonFailureThresholdType,
    updatePassedSnapshot = commonUpdatePassedSnapshot,
    blur = commonBlur,
    runInProcess = commonRunInProcess,
    dumpDiffToConsole = commonDumpDiffToConsole,
    dumpInlineDiffToConsole = commonDumpInlineDiffToConsole,
    allowSizeMismatch = commonAllowSizeMismatch,
    comparisonMethod = commonComparisonMethod,
  } = {}) {
    const {
      testPath, currentTestName, isNot, snapshotState,
    } = this;
    const chalkOptions = {};
    if (typeof noColors !== 'undefined') {
      // 1 means basic ANSI 16-color support, 0 means no support
      chalkOptions.level = noColors ? 0 : 1;
    }
    const chalk = new Chalk(chalkOptions);

    const retryTimes = parseInt(global[Symbol.for('RETRY_TIMES')], 10) || 0;

    if (isNot) { throw new Error('Jest: `.not` cannot be used with `.toMatchImageSnapshot()`.'); }

    updateSnapshotState(snapshotState, { _counters: snapshotState._counters.set(currentTestName, (snapshotState._counters.get(currentTestName) || 0) + 1) }); // eslint-disable-line max-len

    const snapshotIdentifier = createSnapshotIdentifier({
      retryTimes,
      testPath,
      currentTestName,
      customSnapshotIdentifier,
      snapshotState,
    });

    const dirName = currentTestName.split('...');
    const describeName = dirName[0];
    const snapshotsDir = customSnapshotsDir || path.join(path.dirname(testPath), SNAPSHOTS_DIR, kebabCase(describeName));
    const receivedDir = customReceivedDir || path.join(path.dirname(testPath), RECEIVED_DIR, kebabCase(describeName));
    const diffDir = customDiffDir || path.join(path.dirname(testPath), DIFF_DIR, kebabCase(describeName));
    const receivedPostfix = customReceivedPostfix;
    const baselineSnapshotPath = path.join(snapshotsDir, `${snapshotIdentifier}.png`);
    OutdatedSnapshotReporter.markTouchedFile(baselineSnapshotPath);

    if (snapshotState._updateSnapshot === 'none' && !fs.existsSync(baselineSnapshotPath)) {
      return {
        pass: false,
        message: () => `New snapshot was ${chalk.bold.red('not written')}. The update flag must be explicitly ` +
        'passed to write a new snapshot.\n\n + This is likely because this test is run in a continuous ' +
        'integration (CI) environment in which snapshots are not written by default.\n\n',
      };
    }

    const imageToSnapshot = runInProcess ? diffImageToSnapshot : runDiffImageToSnapshot;

    let result =
      imageToSnapshot({
        receivedImageBuffer: received,
        snapshotsDir,
        storeReceivedOnFailure,
        receivedDir,
        receivedPostfix,
        diffDir,
        diffDirection,
        onlyDiff,
        snapshotIdentifier,
        updateSnapshot: snapshotState._updateSnapshot === 'all',
        customDiffConfig: Object.assign({}, commonCustomDiffConfig, customDiffConfig),
        failureThreshold,
        failureThresholdType,
        updatePassedSnapshot,
        blur,
        allowSizeMismatch,
        comparisonMethod,
      });

    if (fs.syncExists(path.join(receivedDir, `${snapshotIdentifier}${receivedPostfix}.png`))) {

      await notifier.notify({
        title: 'Snapshot test failed!',
        message: `Received diff for ${currentTestName}`,
        wait: false,
        timeout: false,
        sound: true,
      });

      process.stdout.write(`\n${chalk.bgCyan(`Received difference for ${currentTestName}`)}\n`);

      const viewTimeout = new Promise((resolve) => {
        setTimeout(resolve, 60000);
      }).then((() => false));
      const view = new Confirm({
        name: 'View Question',
        message: 'Do you want to view the diff in your browser?',
      });
      const viewPromise = view.run();
      const viewAction = await Promise.race([viewTimeout, viewPromise]);
      if (viewAction) {
        childProc.exec(`open -a "Google Chrome file://${diffDir}/${snapshotIdentifier}-diff.png`);
      } else {
        view.stop();
      }

      const updateTimeout = new Promise((resolve) => {
        setTimeout(resolve, 60000);
      }).then((() => false));
      const update = new Confirm({
        name: 'Update Question',
        message: `Do you want to update ${snapshotIdentifier}?`,
      });
      const updatePromise = update.run();
      const updateAction = await Promise.race([updateTimeout, updatePromise]);
      if (updateAction) {
        fs.renameSync(path.join(receivedDir, `${snapshotIdentifier}${receivedPostfix}.png`), path.join(snapshotsDir, `${snapshotIdentifier}.png`));
        result = { updated: true };
      } else {
        update.stop();
      }
    }

    return checkResult({
      result,
      snapshotState,
      retryTimes,
      snapshotIdentifier,
      chalk,
      dumpDiffToConsole,
      dumpInlineDiffToConsole,
      allowSizeMismatch,
    });
  };
}

module.exports = {
  toMatchImageSnapshot: configureToMatchImageSnapshot(),
  configureToMatchImageSnapshot,
  updateSnapshotState,
};
