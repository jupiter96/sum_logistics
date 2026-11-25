import Controller from '@ember/controller';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { task } from 'ember-concurrency';

/**
 * How long the API ignores another request for the same address. It answers as if it had
 * sent the link again, so this page does not offer to until it really would.
 *
 * @type {Number}
 */
export const RESEND_COOLDOWN_SECONDS = 300;

export default class AuthForgotPasswordController extends Controller {
    @service fetch;
    @service notifications;
    @service intl;

    /**
     * The email variable
     *
     * @memberof AuthForgotPasswordController
     */
    @tracked email;

    /**
     * Indicator if request has been sent.
     *
     * @memberof AuthForgotPasswordController
     */
    @tracked isSent = false;

    /**
     * Seconds until the link can be sent to this address again.
     *
     * @memberof AuthForgotPasswordController
     */
    @tracked secondsUntilResend = 0;

    /**
     * Query parameters.
     *
     * @memberof AuthForgotPasswordController
     */
    queryParams = ['email'];

    /**
     * When a link was last requested per address. Kept after leaving the page: the API
     * keeps counting too.
     *
     * @memberof AuthForgotPasswordController
     */
    requestedAt = new Map();

    cooldownTimer = null;

    get trimmedEmail() {
        return String(this.email ?? '').trim();
    }

    get canResend() {
        return this.secondsUntilResend === 0;
    }

    /**
     * Time until the link can be sent again, as m:ss.
     */
    get resendCountdown() {
        const seconds = this.secondsUntilResend;

        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    /**
     * Go back to the form, keeping the address so a typo can be corrected.
     *
     * @memberof AuthForgotPasswordController
     */
    @action changeEmail() {
        this.isSent = false;
        this.stopCooldown();
    }

    /**
     * Sends a secure magic reset link to the user provided email.
     *
     * @memberof AuthForgotPasswordController
     */
    @task({ drop: true }) *sendSecureLink(event) {
        event?.preventDefault?.();

        const email = this.trimmedEmail;

        if (!email) {
            this.notifications.warning(this.intl.t('auth.forgot-password.enter-email'));
            return;
        }

        // Asked for moments ago, e.g. before going back to sign in. The API would ignore
        // the request, and the link it sent is still the one to use.
        if (this.cooldownFor(email) > 0) {
            this.isSent = true;
            this.startCooldown();
            return;
        }

        try {
            yield this.fetch.post('auth/get-magic-reset-link', { email });
        } catch (error) {
            this.notifications.serverError(error);
            return;
        }

        this.requestedAt.set(email.toLowerCase(), Date.now());
        this.isSent = true;
        this.startCooldown();
        this.notifications.success(this.intl.t('auth.forgot-password.success-message'));
    }

    cooldownFor(email) {
        const requestedAt = this.requestedAt.get(email.toLowerCase());

        if (requestedAt === undefined) {
            return 0;
        }

        return Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - (Date.now() - requestedAt) / 1000));
    }

    // Counted from the clock rather than by the ticks, which a background tab slows down.
    updateCooldown() {
        this.secondsUntilResend = this.cooldownFor(this.trimmedEmail);

        if (this.secondsUntilResend === 0) {
            this.stopCooldown();
        }
    }

    startCooldown() {
        this.stopCooldown();
        this.cooldownTimer = setInterval(() => this.updateCooldown(), 1000);
        this.updateCooldown();
    }

    stopCooldown() {
        clearInterval(this.cooldownTimer);
        this.cooldownTimer = null;
    }

    /**
     * Back to an empty form, for the next visit.
     *
     * @memberof AuthForgotPasswordController
     */
    reset() {
        this.stopCooldown();
        this.email = undefined;
        this.isSent = false;
        this.secondsUntilResend = 0;
    }

    willDestroy() {
        super.willDestroy(...arguments);
        this.stopCooldown();
    }
}
