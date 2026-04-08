import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  buildBrowserJourneyCoverageReport,
  validateBrowserJourneyCoverageReport,
} from '../../packages/testing/src/browser-e2e.mjs';
import {
  acceptInviteByRoomName,
  approveNewSessionWithExistingDevice,
  asUserId,
  buildUiAccount,
  changeDisplayName,
  continueNewSessionPastIdentityPrompt,
  createBrowserJourneyRecorder,
  createPrivateRoom,
  dismissForegroundPrompts,
  downloadFileFromTimeline,
  ensureBrowserArtifactRoot,
  inviteUserToCurrentRoom,
  loginViaUi,
  logoutViaUi,
  navigateHome,
  openRoomByCandidates,
  openRoomByName,
  readSelectedRoomEntryName,
  registerViaUi,
  sendMessage,
  setupRecovery,
  startDirectMessage,
  startElementBrowserHarness,
  uploadFileInCurrentRoom,
  waitForBodyText,
  waitForMessageComposer,
  waitForTimelineFile,
  writeJourneyScreenshot,
} from './browser-support.mjs';
import {
  createRoom,
  eventually,
  registerUser,
  requireRemoteHarnessContext,
} from './support.mjs';

const PLAYWRIGHT_PACKAGE_VERSION = '1.59.1';

async function writeCoverageSidecar(outputPath, report) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
}

async function writeJourneyTextArtifact(artifactRoot, journeyId, label, contents) {
  const fileName = `${journeyId.toLowerCase()}-${label}.txt`;
  const destination = path.join(artifactRoot, fileName);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${String(contents).trim()}\n`, 'utf8');
  return path.relative(artifactRoot, destination).replaceAll(path.sep, '/');
}

function formatJourneyError(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function isRetryableBrowserFailure(error) {
  return /Target page, context or browser has been closed|Page crashed|Browser has been closed|browser has disconnected/iu.test(
    formatJourneyError(error),
  );
}

test('TEST-E2E-001 staging drives pinned Element Web mainstream user journeys in a real browser', {
  timeout: 10 * 60 * 1000,
}, async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const maxBrowserAttempts = 2;
  let lastRetryableError = null;
  for (let attempt = 1; attempt <= maxBrowserAttempts; attempt += 1) {
    try {
  const artifactRootPath = process.env.MATRIX_TEST_RUN_BROWSER_ARTIFACT_ROOT
    ?? await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-browser-artifacts-'));
  await fs.rm(artifactRootPath, { recursive: true, force: true });
  const artifactRoot = await ensureBrowserArtifactRoot(artifactRootPath);
  const coverageOutputPath = path.resolve(
    process.env.MATRIX_TEST_RUN_BROWSER_JOURNEY_COVERAGE_PATH
      ?? path.join(artifactRoot, 'browser-journey-coverage.json'),
  );
  const workingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-browser-e2e-'));
  const uploadFixturePath = path.join(workingRoot, 'private-room-upload.txt');
  await fs.writeFile(uploadFixturePath, 'matrix element e2e upload fixture\n', 'utf8');

  const recorder = createBrowserJourneyRecorder();
  let browserVersion = 'unknown';
  let browser = null;
  let elementHarness = null;
  const openContexts = [];
  let coverageValidationError = null;

  const alicePrimarySeed = buildUiAccount('alice', {
    deviceId: 'E2EALICE1',
    password: 'phase08-element-e2e-alice-main',
  });
  const aliceSecondarySeed = {
    username: alicePrimarySeed.username,
    password: alicePrimarySeed.password,
    deviceId: 'E2EALICE2',
  };
  const bobPassword = 'phase08-element-e2e-bob-main';

  let alicePrimaryPage = null;
  let bobPage = null;
  let aliceSecondaryPage = null;
  let aliceVerificationPage = null;
  let dmBobPage = null;
  let alicePrimary = null;
  let bob = null;
  const historyRoomName = `E2E History ${Date.now().toString(36)}`;
  const historyRoomAliceMessage = `history-room-alice-${Date.now().toString(36)}`;
  const privateRoomName = `E2E Private ${Date.now().toString(36)}`;
  const verificationRoomName = `E2E Verify ${Date.now().toString(36)}`;
  const privateRoomAliceMessage = `private-room-alice-${Date.now().toString(36)}`;
  const propagatedDisplayName = `Alice Browser ${Date.now().toString(36)}`;
  const profilePropagationMessage = `profile-propagation-${Date.now().toString(36)}`;
  const dmBootstrapMessage = `dm-bootstrap-${Date.now().toString(36)}`;
  const dmAliceMessage = `dm-alice-${Date.now().toString(36)}`;
  const dmBobReply = `dm-bob-${Date.now().toString(36)}`;
  const encryptedHistoryBeforeVerification = `encrypted-history-${Date.now().toString(36)}`;
  const verificationRoomHistoryMessage = `verification-history-${Date.now().toString(36)}`;

  async function createPage(label) {
    const browserContext = await browser.newContext({
      acceptDownloads: true,
      viewport: {
        width: 1440,
        height: 1024,
      },
    });
    openContexts.push(browserContext);
    const page = await browserContext.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(60_000);
    const state = {
      closed: false,
      crashed: false,
      lastUrl: page.url(),
    };
    page.on('close', () => {
      state.closed = true;
    });
    page.on('crash', () => {
      state.crashed = true;
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        state.lastUrl = frame.url();
      }
    });
    return {
      label,
      context: browserContext,
      page,
      state,
    };
  }

  async function executeJourney(journeyId, {
    page = null,
    pages = [],
    required = true,
    failFast = required,
  } = {}, callback) {
    try {
      const result = await callback();
      recorder.pass(journeyId, {
        artifacts: result?.artifacts ?? [],
        notes: result?.notes ?? null,
      });
      return result?.value;
    } catch (error) {
      const artifacts = await collectFailureArtifacts(
        artifactRoot,
        journeyId,
        pages.length === 0
          ? [{ label: `${journeyId.toLowerCase()}-page`, page, state: null }]
          : pages,
      );
      const pageSummary = summarizeFailurePages(
        pages.length === 0
          ? [{ label: `${journeyId.toLowerCase()}-page`, page, state: null }]
          : pages,
      );
      recorder.fail(journeyId, error, {
        artifacts,
        notes: [
          formatJourneyError(error),
          pageSummary.length === 0 ? null : `page_states: ${pageSummary}`,
        ].filter(Boolean).join('\n\n'),
      });
      if (failFast) {
        throw error;
      }
      return null;
    }
  }

  async function closePageHandle(pageHandle) {
    if (pageHandle?.context == null) {
      return;
    }
    await pageHandle.context.close().catch(() => {});
  }

  try {
    elementHarness = await startElementBrowserHarness(harness);
    browser = await chromium.launch({ headless: true });
    browserVersion = browser.version() || 'unknown';

    const alicePrimaryHandle = await createPage('alice-primary');
    alicePrimaryPage = alicePrimaryHandle.page;

    alicePrimary = await executeJourney('E2E-JRY-001', {
      page: alicePrimaryPage,
    }, async () => {
      const registered = await registerViaUi(alicePrimaryPage, harness, {
        appBaseUrl: elementHarness.appBaseUrl,
        username: alicePrimarySeed.username,
        password: alicePrimarySeed.password,
      });
      return {
        artifacts: [
          await writeJourneyScreenshot(alicePrimaryPage, artifactRoot, 'E2E-JRY-001', 'registered'),
        ],
        value: registered,
      };
    });
    alicePrimary.user_id = asUserId(alicePrimary.username, harness.serverName);

    await executeJourney('E2E-JRY-014', {
      page: alicePrimaryPage,
    }, async () => {
      const recoveryPhrase = await setupRecovery(alicePrimaryPage);
      return {
        artifacts: [
          await writeJourneyScreenshot(alicePrimaryPage, artifactRoot, 'E2E-JRY-014', 'recovery-configured'),
        ],
        value: recoveryPhrase,
      };
    });

    await executeJourney('E2E-JRY-003', {
      page: alicePrimaryPage,
    }, async () => {
      await alicePrimaryPage.reload({ waitUntil: 'domcontentloaded' });
      await dismissForegroundPrompts(alicePrimaryPage);
      await alicePrimaryPage.getByRole('button', { name: 'User menu' }).waitFor({ timeout: 30_000 });
      return {
        artifacts: [
          await writeJourneyScreenshot(alicePrimaryPage, artifactRoot, 'E2E-JRY-003', 'after-reload'),
        ],
      };
    });

    bob = await registerUser(harness, {
      usernamePrefix: 'element-e2e-bob',
      password: bobPassword,
      deviceId: 'E2EBOB1',
    });

    const bobHandle = await createPage('bob-primary');
    bobPage = bobHandle.page;

    await executeJourney('E2E-JRY-002', {
      page: bobPage,
    }, async () => {
      await loginViaUi(bobPage, harness, {
        appBaseUrl: elementHarness.appBaseUrl,
        username: bob.username,
        password: bob.password,
      });
      return {
        artifacts: [
          await writeJourneyScreenshot(bobPage, artifactRoot, 'E2E-JRY-002', 'logged-in'),
        ],
      };
    });

    await createRoom(harness, bob.access_token, {
      name: historyRoomName,
      visibility: 'private',
      invite: [alicePrimary.user_id],
    });
    await eventually(async () => {
      await openRoomByName(alicePrimaryPage, historyRoomName, { invitation: true });
    }, {
      attempts: 120,
      delayMs: 500,
    });
    await acceptInviteByRoomName(alicePrimaryPage, historyRoomName);
    await openRoomByName(alicePrimaryPage, historyRoomName);
    const historyRoomBody = await alicePrimaryPage.textContent('body');
    assert.doesNotMatch(historyRoomBody ?? '', /Encryption enabled|end-to-end encrypted/iu);
    await sendMessage(alicePrimaryPage, historyRoomAliceMessage);
    await openRoomByName(bobPage, historyRoomName);
    await waitForBodyText(bobPage, historyRoomAliceMessage);

    await executeJourney('E2E-JRY-006', {
      page: alicePrimaryPage,
    }, async () => {
      await createPrivateRoom(alicePrimaryPage, privateRoomName);
      await inviteUserToCurrentRoom(alicePrimaryPage, bob.user_id);
      await eventually(async () => {
        await openRoomByName(bobPage, privateRoomName, { invitation: true });
      }, {
        attempts: 120,
        delayMs: 500,
      });
      await acceptInviteByRoomName(bobPage, privateRoomName);
      const aliceArtifact = await writeJourneyScreenshot(alicePrimaryPage, artifactRoot, 'E2E-JRY-006', 'room-established');
      const bobArtifact = await writeJourneyScreenshot(bobPage, artifactRoot, 'E2E-JRY-006', 'invite-accepted');
      return {
        artifacts: [aliceArtifact, bobArtifact],
      };
    });

    await executeJourney('E2E-JRY-013', {
      page: alicePrimaryPage,
    }, async () => {
      await openRoomByName(alicePrimaryPage, privateRoomName);
      await sendMessage(alicePrimaryPage, privateRoomAliceMessage);
      await waitForBodyText(bobPage, privateRoomAliceMessage);
      await sendMessage(alicePrimaryPage, encryptedHistoryBeforeVerification);
      await waitForBodyText(bobPage, encryptedHistoryBeforeVerification);
      const aliceArtifact = await writeJourneyScreenshot(alicePrimaryPage, artifactRoot, 'E2E-JRY-013', 'message-sent');
      const bobArtifact = await writeJourneyScreenshot(bobPage, artifactRoot, 'E2E-JRY-013', 'message-received');
      return {
        artifacts: [aliceArtifact, bobArtifact],
        notes: 'Alice sent room messages in Element Web and Bob received them before the cross-session verification journey.',
      };
    });

    const aliceVerificationHandle = await createPage('alice-verification');
    aliceVerificationPage = aliceVerificationHandle.page;
    const verificationPages = [
      aliceVerificationHandle,
    ];
    let verificationAlicePrimaryHandle = null;

    try {
      await executeJourney('E2E-JRY-015', {
        page: aliceVerificationPage,
        pages: verificationPages,
        failFast: false,
      }, async () => {
        const verificationAliceSeed = buildUiAccount('alice-verify', {
          password: 'phase08-element-e2e-alice-verify-primary',
        });
        verificationAlicePrimaryHandle = await createPage('alice-verify-primary');
        const verificationAlicePrimaryPage = verificationAlicePrimaryHandle.page;
        verificationPages.push(verificationAlicePrimaryHandle);
        const verificationBob = await registerUser(harness, {
          usernamePrefix: 'element-e2e-verify-bob',
          password: 'phase08-element-e2e-verify-bob-main',
          deviceId: 'E2EBOBV1',
        });
        const verificationBobHandle = await createPage('bob-verify');
        const verificationBobPage = verificationBobHandle.page;
        verificationPages.push(verificationBobHandle);
        const verificationArtifacts = [];

        await registerViaUi(verificationAlicePrimaryPage, harness, {
          appBaseUrl: elementHarness.appBaseUrl,
          username: verificationAliceSeed.username,
          password: verificationAliceSeed.password,
        });
        await setupRecovery(verificationAlicePrimaryPage);
        await loginViaUi(verificationBobPage, harness, {
          appBaseUrl: elementHarness.appBaseUrl,
          username: verificationBob.username,
          password: verificationBob.password,
        });
        await createPrivateRoom(verificationAlicePrimaryPage, verificationRoomName);
        await inviteUserToCurrentRoom(verificationAlicePrimaryPage, verificationBob.user_id);
        await eventually(async () => {
          await openRoomByName(verificationBobPage, verificationRoomName, { invitation: true });
        }, {
          attempts: 120,
          delayMs: 500,
        });
        await acceptInviteByRoomName(verificationBobPage, verificationRoomName);
        await openRoomByName(verificationAlicePrimaryPage, verificationRoomName);
        const roomKeyBackupReadyBeforeNewSession = waitForRoomKeyBackupUpload(verificationAlicePrimaryPage);
        await sendMessage(verificationAlicePrimaryPage, verificationRoomHistoryMessage);
        await waitForBodyText(verificationBobPage, verificationRoomHistoryMessage);
        const roomKeyBackupReady = await roomKeyBackupReadyBeforeNewSession;
        assert.equal(
          roomKeyBackupReady,
          true,
          'expected the existing verified session to upload room keys before the new-session restore path starts',
        );
        await closePageHandle(verificationBobHandle);

        await loginViaUi(aliceVerificationPage, harness, {
          appBaseUrl: elementHarness.appBaseUrl,
          username: verificationAliceSeed.username,
          password: verificationAliceSeed.password,
          allowVerificationPrompt: true,
        });
        verificationArtifacts.push(
          await writeJourneyScreenshot(aliceVerificationPage, artifactRoot, 'E2E-JRY-015', 'verification-prompt'),
        );
        const roomKeyRestore = waitForRoomKeyRestore(aliceVerificationPage);
        await approveNewSessionWithExistingDevice(verificationAlicePrimaryPage, aliceVerificationPage);
        verificationArtifacts.push(
          await writeJourneyScreenshot(aliceVerificationPage, artifactRoot, 'E2E-JRY-015', 'verification-approved'),
        );
        await waitForHistoryAfterVerification(
          aliceVerificationPage,
          elementHarness.appBaseUrl,
          verificationRoomName,
          verificationRoomHistoryMessage,
          {
            roomKeyBackupUpload: Promise.resolve(roomKeyBackupReady),
            roomKeyRestore,
          },
        );
        return {
          artifacts: [
            ...verificationArtifacts,
            await writeJourneyScreenshot(aliceVerificationPage, artifactRoot, 'E2E-JRY-015', 'history-visible-after-verification'),
          ],
        };
      });
    } finally {
      await closePageHandle(verificationAlicePrimaryHandle);
      await closePageHandle(aliceVerificationHandle);
      aliceVerificationPage = null;
    }

    await executeJourney('E2E-JRY-008', {
      page: bobPage,
    }, async () => {
      const uploadedFileName = await uploadFileInCurrentRoom(alicePrimaryPage, uploadFixturePath);
      await waitForTimelineFile(bobPage, uploadedFileName);
      const downloadedPath = await downloadFileFromTimeline(
        bobPage,
        uploadedFileName,
        path.join(artifactRoot, 'downloads'),
      );
      assert.equal(await fs.readFile(downloadedPath, 'utf8'), 'matrix element e2e upload fixture\n');
      return {
        artifacts: [
          await writeJourneyScreenshot(alicePrimaryPage, artifactRoot, 'E2E-JRY-008', 'uploaded'),
          await writeJourneyScreenshot(bobPage, artifactRoot, 'E2E-JRY-008', 'downloaded'),
          path.relative(artifactRoot, downloadedPath).replaceAll(path.sep, '/'),
        ],
      };
    });

    await executeJourney('E2E-JRY-009', {
      page: bobPage,
    }, async () => {
      await changeDisplayName(alicePrimaryPage, propagatedDisplayName);
      await openRoomByName(alicePrimaryPage, privateRoomName);
      await sendMessage(alicePrimaryPage, profilePropagationMessage);
      await waitForBodyText(bobPage, profilePropagationMessage);
      await waitForBodyText(bobPage, propagatedDisplayName);
      return {
        artifacts: [
          await writeJourneyScreenshot(alicePrimaryPage, artifactRoot, 'E2E-JRY-009', 'alice-profile-updated'),
          await writeJourneyScreenshot(bobPage, artifactRoot, 'E2E-JRY-009', 'bob-observed-update'),
        ],
      };
    });

    await executeJourney('E2E-JRY-004', {
      page: alicePrimaryPage,
    }, async () => {
      await logoutViaUi(alicePrimaryPage);
      await loginViaUi(alicePrimaryPage, harness, {
        appBaseUrl: elementHarness.appBaseUrl,
        username: alicePrimary.username,
        password: alicePrimary.password,
        allowVerificationPrompt: true,
      });
      await continueNewSessionPastIdentityPrompt(alicePrimaryPage);
      await eventually(async () => {
        await dismissForegroundPrompts(alicePrimaryPage);
        const bodyText = await alicePrimaryPage.textContent('body');
        assert.doesNotMatch(bodyText ?? '', /Start verification on the other device/iu);
      }, {
        attempts: 60,
        delayMs: 500,
      });
      await openRoomByName(alicePrimaryPage, historyRoomName);
      await waitForBodyText(alicePrimaryPage, historyRoomAliceMessage);
      return {
        artifacts: [
          await writeJourneyScreenshot(alicePrimaryPage, artifactRoot, 'E2E-JRY-004', 'history-after-relogin'),
        ],
      };
    });

    const aliceSecondaryHandle = await createPage('alice-secondary');
    aliceSecondaryPage = aliceSecondaryHandle.page;

    try {
      await executeJourney('E2E-JRY-005', {
        page: aliceSecondaryPage,
      }, async () => {
        await loginViaUi(aliceSecondaryPage, harness, {
          appBaseUrl: elementHarness.appBaseUrl,
          username: aliceSecondarySeed.username,
          password: aliceSecondarySeed.password,
          allowVerificationPrompt: true,
        });
        await continueNewSessionPastIdentityPrompt(aliceSecondaryPage);
        await eventually(async () => {
          await dismissForegroundPrompts(aliceSecondaryPage);
          const bodyText = await aliceSecondaryPage.textContent('body');
          assert.doesNotMatch(bodyText ?? '', /Start verification on the other device/iu);
        }, {
          attempts: 60,
          delayMs: 500,
        });
        await openRoomByName(aliceSecondaryPage, historyRoomName);
        await waitForBodyText(aliceSecondaryPage, historyRoomAliceMessage);
        return {
          artifacts: [
            await writeJourneyScreenshot(aliceSecondaryPage, artifactRoot, 'E2E-JRY-005', 'new-device-history'),
          ],
        };
      });
    } finally {
      await closePageHandle(aliceSecondaryHandle);
      aliceSecondaryPage = null;
    }

    const dmJourneyPages = [alicePrimaryHandle];
    const dmBobHandles = [];
    try {
      await executeJourney('E2E-JRY-007', {
        page: alicePrimaryPage,
        pages: dmJourneyPages,
      }, async () => {
        const dmBob = await registerUser(harness, {
          usernamePrefix: 'element-e2e-dm-bob',
          password: 'phase08-element-e2e-dm-bob-main',
          deviceId: 'E2EDMB1',
        });
        const dmBobHandle = await createPage('bob-dm');
        dmBobHandles.push(dmBobHandle);
        dmJourneyPages.push(dmBobHandle);
        dmBobPage = dmBobHandle.page;
      await loginViaUi(dmBobPage, harness, {
        appBaseUrl: elementHarness.appBaseUrl,
        username: dmBob.username,
        password: dmBob.password,
      });
      await startDirectMessage(alicePrimaryPage, dmBob.user_id);
      await waitForMessageComposer(alicePrimaryPage);
      await sendMessage(alicePrimaryPage, dmBootstrapMessage);
      const dmRoomCandidates = [
        alicePrimary.user_id,
        alicePrimary.username,
      ].filter((value) => typeof value === 'string' && value.length > 0);
      await eventually(async () => {
        await dismissForegroundPrompts(dmBobPage);
          for (const invitation of [true, false]) {
            try {
              await openRoomByCandidates(dmBobPage, dmRoomCandidates, { invitation });
              return;
            } catch {
              // Try the next room-list shape before failing the attempt.
            }
          }
          const inviteOptions = dmBobPage.getByRole('option', { name: /Open room .* invitation\./iu });
          const inviteButtons = dmBobPage.getByRole('button', { name: /Open room .* invitation\./iu });
          if (await inviteOptions.count() > 0) {
            await inviteOptions.first().click();
            return;
          }
          if (await inviteButtons.count() > 0) {
            await inviteButtons.first().click();
            return;
          }
          throw new Error(`unable to locate DM room or invitation for ${dmRoomCandidates.join(', ')}`);
      }, {
        attempts: 120,
        delayMs: 500,
      });
      const bobDmRoomId = await acceptInviteOrWaitForComposer(dmBobPage);
      const aliceDmRoomId = readCurrentRoomIdFromPage(alicePrimaryPage);
      assert.ok(aliceDmRoomId, 'expected Alice to remain inside a DM room after starting the direct message');
      assert.ok(bobDmRoomId, 'expected Bob to reach a concrete DM room after accepting the invite');
      assert.equal(
        bobDmRoomId,
        aliceDmRoomId,
        `expected Alice and Bob to point at the same DM room, received alice=${aliceDmRoomId} bob=${bobDmRoomId}`,
      );
      await waitForEncryptedTimelineReady(dmBobPage);
      await sendMessage(alicePrimaryPage, dmAliceMessage);
      await waitForBodyText(dmBobPage, dmAliceMessage);
      await waitForEncryptedTimelineReady(dmBobPage);
      await sendMessage(dmBobPage, dmBobReply);
      await waitForBodyText(alicePrimaryPage, dmBobReply);
        return {
          artifacts: [
            await writeJourneyScreenshot(alicePrimaryPage, artifactRoot, 'E2E-JRY-007', 'alice-dm'),
            await writeJourneyScreenshot(dmBobPage, artifactRoot, 'E2E-JRY-007', 'bob-dm'),
          ],
        };
      });
    } finally {
      for (const dmBobHandle of dmBobHandles) {
        await closePageHandle(dmBobHandle);
      }
      dmBobPage = null;
    }
  } finally {
    recorder.fail('E2E-JRY-010', 'Optional journey not yet covered by the canonical mandatory slice.', {
      notes: 'Optional journey intentionally left outside the current P0 gate.',
    });
    recorder.fail('E2E-JRY-011', 'Optional journey not yet covered by the canonical mandatory slice.', {
      notes: 'Optional journey intentionally left outside the current P0 gate.',
    });
    recorder.fail('E2E-JRY-012', 'Optional journey not yet covered by the canonical mandatory slice.', {
      notes: 'Optional journey intentionally left outside the current P0 gate.',
    });

    for (const browserContext of openContexts.reverse()) {
      await browserContext.close().catch(() => {});
    }
    await browser?.close().catch(() => {});
    await elementHarness?.server?.close().catch(() => {});

    const report = buildBrowserJourneyCoverageReport({
      environmentName: 'staging',
      journeys: recorder.toArray(),
      playwright: {
        package_version: PLAYWRIGHT_PACKAGE_VERSION,
        browser_name: 'chromium',
        browser_version: browserVersion,
        headless: true,
      },
    });
    await writeCoverageSidecar(coverageOutputPath, report);
    const coverageValidation = validateBrowserJourneyCoverageReport(report, {
      expectedEnvironmentName: 'staging',
    });
    coverageValidationError = coverageValidation.valid === true
      ? null
      : coverageValidation.error ?? 'TEST-E2E-001 browser journey coverage validation failed';
    await fs.rm(workingRoot, { recursive: true, force: true });
  }
  assert.equal(coverageValidationError, null, coverageValidationError ?? undefined);
      return;
    } catch (error) {
      if (attempt < maxBrowserAttempts && isRetryableBrowserFailure(error)) {
        lastRetryableError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastRetryableError;
});

async function safeAcceptInvite(page) {
  await eventually(async () => {
    const acceptButton = page.getByRole('button', { name: 'Accept' });
    assert.equal(await acceptButton.count() > 0, true);
    await acceptButton.first().click();
  }, {
    attempts: 60,
    delayMs: 500,
  });
}

function readCurrentRoomIdFromPage(page) {
  const match = String(page?.url?.() ?? '').match(/#\/room\/([^/?#]+)/u);
  return match?.[1] ?? null;
}

async function acceptInviteOrWaitForComposer(page) {
  await eventually(async () => {
    const acceptButton = page.getByRole('button', { name: 'Accept' });
    if (
      await acceptButton.count() > 0
      && await acceptButton.first().isVisible().catch(() => false)
    ) {
      await safeAcceptInvite(page);
    }
    await waitForMessageComposer(page);
    assert.match(page.url(), /#\/room\//u);
    const acceptStillVisible = (
      await acceptButton.count() > 0
      && await acceptButton.first().isVisible().catch(() => false)
    );
    assert.equal(acceptStillVisible, false, 'invite accept button remained visible after the room composer appeared');
  }, {
    attempts: 120,
    delayMs: 500,
  });

  return readCurrentRoomIdFromPage(page);
}

function waitForRoomKeyBackupUpload(page) {
  return page.waitForResponse((response) => (
    response.request().method() === 'PUT'
      && /\/_matrix\/client\/(?:r0|v1|v3)\/room_keys\/keys(?:\/.*)?\?version=/u.test(response.url())
      && response.status() === 200
  ), {
    timeout: 60_000,
  }).then(() => true).catch(() => false);
}

function waitForRoomKeyRestore(page) {
  return page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && /\/_matrix\/client\/(?:r0|v1|v3)\/room_keys(?:\/.*)?(?:\?version=.*)?$/u.test(response.url())
      && response.status() === 200
  ), {
    timeout: 90_000,
  }).then(() => true).catch(() => false);
}

function observeBooleanSignal(promise) {
  const state = {
    settled: false,
    value: null,
  };
  const wrapped = Promise.resolve(promise)
    .then((value) => {
      state.settled = true;
      state.value = value === true;
      return state.value;
    })
    .catch(() => {
      state.settled = true;
      state.value = false;
      return false;
    });
  return {
    promise: wrapped,
    get settled() {
      return state.settled;
    },
    get value() {
      return state.value;
    },
  };
}

async function readNormalizedBodyText(page) {
  return String(await page.textContent('body').catch(() => ''))
    .replace(/\s+/gu, ' ')
    .trim();
}

async function readMessageComposerState(page) {
  if (page == null || page.isClosed()) {
    return null;
  }
  const composer = page.locator('.mx_MessageComposer').first();
  const composerVisible = await composer.isVisible().catch(() => false);
  if (!composerVisible) {
    return null;
  }
  const textbox = composer.locator('div[contenteditable="true"][role="textbox"]').first();
  return {
    composer_text: String(await composer.textContent().catch(() => ''))
      .replace(/\s+/gu, ' ')
      .trim(),
    textbox_aria_label: await textbox.getAttribute('aria-label').catch(() => null),
    textbox_aria_placeholder: await textbox.getAttribute('aria-placeholder').catch(() => null),
    textbox_placeholder: await textbox.getAttribute('placeholder').catch(() => null),
    textbox_text: String(await textbox.textContent().catch(() => ''))
      .replace(/\s+/gu, ' ')
      .trim(),
  };
}

function summarizeFailurePages(pageHandles) {
  return pageHandles
    .filter((pageHandle) => pageHandle?.page != null)
    .map((pageHandle) => {
      const pageState = pageHandle.state ?? {};
      const lastUrl = pageState.lastUrl ?? pageHandle.page.url?.() ?? 'unknown';
      return `${pageHandle.label}[closed=${String(pageHandle.page.isClosed())},crashed=${String(pageState.crashed === true)},url=${lastUrl}]`;
    })
    .join(' | ');
}

async function collectFailureArtifacts(artifactRoot, journeyId, pageHandles) {
  const artifacts = [];
  for (const pageHandle of pageHandles) {
    if (pageHandle?.page == null) {
      continue;
    }
    const pageState = pageHandle.state ?? {};
    const selectedRoom = pageHandle.page.isClosed()
      ? null
      : await readSelectedRoomEntryName(pageHandle.page).catch(() => null);
    const currentRoomId = pageHandle.page.isClosed()
      ? null
      : readCurrentRoomIdFromPage(pageHandle.page);
    artifacts.push(await writeJourneyTextArtifact(
      artifactRoot,
      journeyId,
      `${pageHandle.label}-state`,
      JSON.stringify({
        label: pageHandle.label,
        closed: pageHandle.page.isClosed(),
        crashed: pageState.crashed === true,
        last_url: pageState.lastUrl ?? null,
        selected_room: selectedRoom,
        current_room_id: currentRoomId,
      }, null, 2),
    ));
    if (pageHandle.page.isClosed()) {
      continue;
    }
    try {
      artifacts.push(await writeJourneyScreenshot(pageHandle.page, artifactRoot, journeyId, `${pageHandle.label}-failure`));
    } catch {
      // Ignore secondary screenshot failures.
    }
    const bodyText = await readNormalizedBodyText(pageHandle.page).catch(() => '');
    if (bodyText.length > 0) {
      artifacts.push(await writeJourneyTextArtifact(
        artifactRoot,
        journeyId,
        `${pageHandle.label}-body`,
        bodyText,
      ));
    }
    const composerState = await readMessageComposerState(pageHandle.page).catch(() => null);
    if (composerState != null) {
      artifacts.push(await writeJourneyTextArtifact(
        artifactRoot,
        journeyId,
        `${pageHandle.label}-composer`,
        JSON.stringify(composerState, null, 2),
      ));
    }
  }
  return artifacts;
}

async function bodyContainsPattern(page, pattern) {
  return pattern.test(await readNormalizedBodyText(page));
}

async function waitForBodyPattern(page, pattern, {
  attempts = 8,
  delayMs = 500,
} = {}) {
  try {
    await eventually(async () => {
      const bodyText = await page.textContent('body');
      assert.match(bodyText ?? '', pattern);
    }, {
      attempts,
      delayMs,
    });
    return true;
  } catch {
    return bodyContainsPattern(page, pattern);
  }
}

async function waitForEncryptedTimelineReady(page) {
  await eventually(async () => {
    const bodyText = await readNormalizedBodyText(page);
    const composerState = await readMessageComposerState(page);
    assert.ok(composerState, 'expected the room message composer to be visible before asserting encryption state');
    const composerSignal = [
      composerState.textbox_aria_label,
      composerState.textbox_aria_placeholder,
      composerState.textbox_placeholder,
      composerState.composer_text,
    ]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .join(' ');
    assert.doesNotMatch(
      composerSignal,
      /Send an unencrypted message/iu,
      `expected the current room composer to be encrypted, received ${JSON.stringify(composerState)}`,
    );
    assert.doesNotMatch(bodyText, /Messages in this room are not end-to-end encrypted|End-to-end encryption isn't enabled/iu);
    assert.match(bodyText, /Encryption enabled|end-to-end encrypted/iu);
  }, {
    attempts: 60,
    delayMs: 500,
  });
}

async function waitForHistoryAfterVerification(page, appBaseUrl, roomName, expectedText, {
  roomKeyBackupUpload = null,
  roomKeyRestore = null,
} = {}) {
  const expectedPattern = new RegExp(expectedText.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u');
  const backupUploadSignal = observeBooleanSignal(roomKeyBackupUpload);
  const restoreSignal = observeBooleanSignal(roomKeyRestore);
  let lastBodyText = '';
  let reloadAttempted = false;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if (page.isClosed()) {
      throw new Error('verification history page closed before encrypted history became visible');
    }
    if (attempt > 1) {
      await navigateHome(page, appBaseUrl);
    }
    await page.waitForTimeout(attempt === 1 ? 1_500 : 2_000);
    await dismissForegroundPrompts(page, { preserveVerification: true });
    await openRoomByName(page, roomName);

    if (await waitForBodyPattern(page, expectedPattern, {
      attempts: 8,
      delayMs: 500,
    })) {
      return;
    }

    lastBodyText = await readNormalizedBodyText(page);
    const decryptPlaceholderVisible = /Unable to decrypt message|This message could not be decrypted|can't be guaranteed on this device/iu.test(lastBodyText);
    const waitSignals = [
      page.waitForTimeout(decryptPlaceholderVisible ? 15_000 : 6_000),
    ];
    if (!backupUploadSignal.settled) {
      waitSignals.push(backupUploadSignal.promise);
    }
    if (!restoreSignal.settled) {
      waitSignals.push(restoreSignal.promise);
    }
    await Promise.race(waitSignals);

    if (await waitForBodyPattern(page, expectedPattern, {
      attempts: decryptPlaceholderVisible || restoreSignal.value === true ? 12 : 6,
      delayMs: 1_000,
    })) {
      return;
    }

    lastBodyText = await readNormalizedBodyText(page);
    await navigateHome(page, appBaseUrl);

    const reopenAttempts = restoreSignal.value === true || backupUploadSignal.value === true || decryptPlaceholderVisible ? 3 : 1;
    for (let reopenAttempt = 1; reopenAttempt <= reopenAttempts; reopenAttempt += 1) {
      await page.waitForTimeout(1_500);
      await dismissForegroundPrompts(page, { preserveVerification: true });
      await openRoomByName(page, roomName);
      if (await waitForBodyPattern(page, expectedPattern, {
        attempts: 6,
        delayMs: 500,
      })) {
        return;
      }
      lastBodyText = await readNormalizedBodyText(page);
      if (expectedPattern.test(lastBodyText)) {
        return;
      }
      if (reopenAttempt < reopenAttempts) {
        await page.waitForTimeout(2_000);
        await navigateHome(page, appBaseUrl);
      }
    }

    if (
      !reloadAttempted
      && restoreSignal.value === true
      && backupUploadSignal.value === true
    ) {
      reloadAttempted = true;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3_000);
      await dismissForegroundPrompts(page, { preserveVerification: true });
      await openRoomByName(page, roomName);
      if (await waitForBodyPattern(page, expectedPattern, {
        attempts: 10,
        delayMs: 750,
      })) {
        return;
      }
      lastBodyText = await readNormalizedBodyText(page);
    }
  }
  const signalSummary = [
    `roomKeyBackupUpload=${backupUploadSignal.settled ? String(backupUploadSignal.value) : 'pending'}`,
    `roomKeyRestore=${restoreSignal.settled ? String(restoreSignal.value) : 'pending'}`,
  ].join(', ');
  throw new Error(
    `history did not become visible after verification (${signalSummary}); last body snapshot: ${lastBodyText.slice(0, 600)}`,
  );
}
