import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { task, timeout, all } from 'ember-concurrency';
import { format } from 'date-fns';
import { API_STATUS_GROUPS } from '@summit_logistics/console/utils/api-status-catalog';
import { CONCURRENCY, apiUrl, classify, formatBytes, formatDuration, paceFromRateLimits, probe, resolveApiPath, summarize } from '@summit_logistics/console/utils/api-status';

export const STATE_CLASSES = {
    ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
    warning: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-100',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
    running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
    pending: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    idle: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

const TONE_CLASSES = {
    ok: 'text-green-700 dark:text-green-300',
    warning: 'text-yellow-700 dark:text-yellow-200',
    failed: 'text-red-600 dark:text-red-300',
};

const IDLE = { state: 'idle', label: 'Not run' };
const PENDING = { state: 'pending', label: 'Queued' };
const RUNNING = { state: 'running', label: 'Checking' };
const PROBLEM_STATES = ['warning', 'failed'];
const UNFINISHED_STATES = ['pending', 'running'];
const PREVIEW_LENGTH = 4000;

export const GROUPS = API_STATUS_GROUPS.map((group) => ({
    ...group,
    checks: group.checks.map((check) => ({ ...check, id: `/${check.path}`, groupId: group.id })),
}));

export const CHECKS = GROUPS.flatMap((group) => group.checks);

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Read-only health checks of the API endpoints the console and its extensions depend on.
 *
 * Each check sends one GET with the signed-in session, straight through window.fetch so
 * the HTTP status and timing are visible (the fetch service hides both). Runs are paced
 * to half of the API rate limit, so checking does not throttle the console itself.
 */
export default class AdminApiStatusComponent extends Component {
    @service fetch;
    @service notifications;

    @tracked results = {};
    @tracked filter = 'all';
    @tracked lastRunAt = null;
    @tracked intervalMs = null;
    @tracked runTotal = 0;
    @tracked runDone = 0;
    @tracked customPath = '';
    @tracked customResult = null;

    nextSlotAt = 0;

    get host() {
        return this.fetch.host;
    }

    get totalChecks() {
        return CHECKS.length;
    }

    get problemChecks() {
        return CHECKS.filter((check) => PROBLEM_STATES.includes(this.results[check.id]?.state));
    }

    get summary() {
        return summarize(CHECKS.map((check) => this.results[check.id]));
    }

    get stats() {
        const summary = this.summary;

        return [
            { key: 'total', label: 'Endpoints', value: CHECKS.length, hint: summary.checked < CHECKS.length ? `${CHECKS.length - summary.checked} not run` : null },
            { key: 'ok', label: 'Working', value: summary.ok, toneClass: summary.ok ? TONE_CLASSES.ok : null },
            { key: 'warning', label: 'Warnings', value: summary.warning, toneClass: summary.warning ? TONE_CLASSES.warning : null },
            { key: 'failed', label: 'Failed', value: summary.failed, toneClass: summary.failed ? TONE_CLASSES.failed : null },
            {
                key: 'average',
                label: 'Avg response',
                value: formatDuration(summary.averageMs),
                hint: summary.slowestMs === null ? null : `slowest ${formatDuration(summary.slowestMs)}`,
            },
        ];
    }

    get groups() {
        const problemsOnly = this.filter === 'problems';

        return GROUPS.map((group) => {
            const allRows = group.checks.map((check) => this.rowFor(check));
            const rows = problemsOnly ? allRows.filter((row) => PROBLEM_STATES.includes(row.result.state)) : allRows;

            return { ...group, rows, headline: this.headlineFor(allRows) };
        }).filter((group) => group.rows.length > 0);
    }

    get progress() {
        if (!this.runChecks.isRunning || !this.runTotal) {
            return null;
        }

        const remaining = Math.max(0, this.runTotal - this.runDone);

        return {
            done: this.runDone,
            total: this.runTotal,
            percent: Math.round((this.runDone / this.runTotal) * 100),
            eta: this.intervalMs ? formatDuration(remaining * this.intervalMs) : null,
        };
    }

    get paceLabel() {
        if (this.intervalMs === null) {
            return null;
        }

        if (this.intervalMs === 0) {
            return `Rate limiting is off, so checks run ${CONCURRENCY} at a time.`;
        }

        return `Paced to about ${Math.max(1, Math.round(60000 / this.intervalMs))} requests a minute, half of the API rate limit, so the console keeps working during a run.`;
    }

    get lastRunLabel() {
        return this.lastRunAt ? format(this.lastRunAt, 'd MMM yyyy, HH:mm:ss') : null;
    }

    rowFor(check) {
        const result = this.results[check.id] ?? IDLE;

        return {
            ...check,
            result,
            stateClass: STATE_CLASSES[result.state] ?? STATE_CLASSES.idle,
            messageClass: result.state === 'failed' ? TONE_CLASSES.failed : TONE_CLASSES.warning,
            isBusy: result.state === 'running',
            duration: Number.isFinite(result.ms) ? formatDuration(result.ms) : null,
            size: Number.isFinite(result.bytes) ? formatBytes(result.bytes) : null,
        };
    }

    headlineFor(rows) {
        const counts = { ok: 0, warning: 0, failed: 0 };
        for (const row of rows) {
            if (row.result.state in counts) {
                counts[row.result.state]++;
            }
        }

        if (counts.ok + counts.warning + counts.failed === 0) {
            return { text: plural(rows.length, 'endpoint'), toneClass: null };
        }
        if (counts.failed) {
            return { text: `${counts.failed} failed${counts.warning ? `, ${plural(counts.warning, 'warning')}` : ''}`, toneClass: TONE_CLASSES.failed };
        }
        if (counts.warning) {
            return { text: plural(counts.warning, 'warning'), toneClass: TONE_CLASSES.warning };
        }
        if (counts.ok === rows.length) {
            return { text: `All ${rows.length} OK`, toneClass: TONE_CLASSES.ok };
        }
        return { text: `${counts.ok} of ${rows.length} OK`, toneClass: TONE_CLASSES.ok };
    }

    @action runAll() {
        return this.runChecks.perform(CHECKS);
    }

    @action runProblems() {
        return this.runChecks.perform(this.problemChecks);
    }

    @action runGroup(group) {
        return this.runChecks.perform(group.checks);
    }

    @action stop() {
        this.runChecks.cancelAll();
        this.runCheck.cancelAll();
    }

    @action setFilter(filter) {
        this.filter = filter;
    }

    @action submitCustom(event) {
        event?.preventDefault?.();
        return this.runCustom.perform();
    }

    @task({ drop: true }) *runChecks(checks = []) {
        const list = [...checks];
        if (!list.length) {
            return;
        }

        const previous = this.results;
        this.intervalMs = yield this.readPace();
        this.nextSlotAt = 0;
        this.runTotal = list.length;
        this.runDone = 0;
        this.results = { ...this.results, ...Object.fromEntries(list.map((check) => [check.id, PENDING])) };

        let finished = false;
        try {
            yield all(list.map((check) => this.runCheck.perform(check)));
            finished = true;
        } finally {
            if (finished) {
                this.lastRunAt = new Date();
                this.notifyRun(list);
            } else {
                // Stopped: checks that never got an answer show what they showed before.
                const restored = { ...this.results };
                for (const check of list) {
                    if (UNFINISHED_STATES.includes(restored[check.id]?.state)) {
                        if (previous[check.id]) {
                            restored[check.id] = previous[check.id];
                        } else {
                            delete restored[check.id];
                        }
                    }
                }
                this.results = restored;
            }
        }
    }

    @task({ enqueue: true, maxConcurrency: CONCURRENCY }) *runCheck(check) {
        const wait = this.reserveSlot();
        if (wait > 0) {
            yield timeout(wait);
        }

        this.setResult(check.id, RUNNING);
        const controller = new AbortController();
        try {
            const response = yield probe(apiUrl(this.fetch.host, check.path), this.probeOptions(controller));
            this.setResult(check.id, this.resultFrom(response));
        } finally {
            // Cancelling the task (Stop, or leaving the page) cancels the request too.
            controller.abort();
            this.runDone++;
        }
    }

    @task({ restartable: true }) *runCustom() {
        const target = resolveApiPath(this.customPath, this.fetch.host);
        if (target.error) {
            this.customResult = { state: 'failed', label: 'Invalid path', message: target.error, stateClass: STATE_CLASSES.failed };
            return;
        }

        const controller = new AbortController();
        try {
            const response = yield probe(target.url, this.probeOptions(controller));
            const result = this.resultFrom(response);
            this.customResult = {
                ...result,
                path: target.path,
                stateClass: STATE_CLASSES[result.state],
                duration: Number.isFinite(result.ms) ? formatDuration(result.ms) : null,
                size: Number.isFinite(result.bytes) ? formatBytes(result.bytes) : null,
                preview: this.previewFor(response.body),
            };
        } finally {
            controller.abort();
        }
    }

    probeOptions(controller) {
        return { headers: this.fetch.getHeaders(), credentials: this.fetch.credentials, signal: controller.signal };
    }

    resultFrom(response) {
        return {
            ...classify(response),
            httpStatus: response.httpStatus ?? null,
            ms: response.ms,
            bytes: response.bytes,
            checkedAt: new Date(),
        };
    }

    previewFor(body) {
        if (body === null || body === undefined) {
            return null;
        }
        const text = JSON.stringify(body, null, 2);
        return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}\n… (${formatBytes(text.length)} in total)` : text;
    }

    setResult(id, result) {
        this.results = { ...this.results, [id]: result };
    }

    // Spreads check starts at least `intervalMs` apart; returns how long this one waits.
    reserveSlot() {
        const now = Date.now();
        const startAt = Math.max(now, this.nextSlotAt);
        this.nextSlotAt = startAt + (this.intervalMs ?? 0);
        return startAt - now;
    }

    async readPace() {
        try {
            return paceFromRateLimits(await this.fetch.get('rate-limits/settings'));
        } catch (error) {
            return paceFromRateLimits(null);
        }
    }

    notifyRun(list) {
        const summary = summarize(list.map((check) => this.results[check.id]));

        if (summary.failed) {
            this.notifications.error(`${summary.failed} of ${plural(list.length, 'endpoint')} failed.`);
        } else if (summary.warning) {
            this.notifications.warning(`All ${plural(list.length, 'endpoint')} answered, ${plural(summary.warning, 'warning')} to look at.`);
        } else {
            this.notifications.success(`All ${plural(list.length, 'endpoint')} are working.`);
        }
    }
}
