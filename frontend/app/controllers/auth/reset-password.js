import Controller from '@ember/controller';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { task } from 'ember-concurrency';
import passwordRequirements from '@summit_logistics/console/utils/password-requirements';

export default class AuthResetPasswordController extends Controller {
    @service fetch;
    @service notifications;
    @service router;
    @service intl;

    /**
     * The code param.
     *
     * @memberof AuthResetPasswordController
     */
    @tracked code;

    /**
     * Users new password.
     *
     * @memberof AuthResetPasswordController
     */
    @tracked password;

    /**
     * Users new password confirmation.
     *
     * @memberof AuthResetPasswordController
     */
    @tracked password_confirmation;

    /**
     * Whether the link is expired, already used or was never valid.
     *
     * @memberof AuthResetPasswordController
     */
    @tracked isLinkInvalid = false;

    /**
     * Whether the link carried the code, so there is no need to ask for it. Set when the
     * page opens: following `code` would remove its field on the first character typed.
     *
     * @memberof AuthResetPasswordController
     */
    @tracked hasCodeFromLink = false;

    /**
     * Whether the passwords are shown as typed.
     *
     * @memberof AuthResetPasswordController
     */
    @tracked isPasswordVisible = false;

    /**
     * Query parameters.
     *
     * @memberof AuthResetPasswordController
     */
    queryParams = ['code'];

    /**
     * What the new password needs, and what it has so far.
     *
     * @memberof AuthResetPasswordController
     */
    get requirements() {
        const requirements = passwordRequirements(this.password).map(({ key, isMet }) => ({
            key,
            isMet,
            label: this.intl.t(`auth.reset-password.requirements.${key}`),
        }));

        return [...requirements, { key: 'match', isMet: this.passwordsMatch, label: this.intl.t('auth.reset-password.requirements.match') }];
    }

    get passwordsMatch() {
        return Boolean(this.password) && this.password === this.password_confirmation;
    }

    get isReady() {
        return Boolean(String(this.code ?? '').trim()) && this.passwordsMatch && passwordRequirements(this.password).every(({ isMet }) => isMet);
    }

    @action togglePasswordVisibility() {
        this.isPasswordVisible = !this.isPasswordVisible;
    }

    /**
     * The reset password task.
     *
     * @memberof AuthResetPasswordController
     */
    @task({ drop: true }) *resetPassword(event) {
        event?.preventDefault?.();

        if (!this.isReady) {
            return;
        }

        const { password, password_confirmation } = this;
        const { id } = this.model;

        try {
            yield this.fetch.post('auth/reset-password', { link: id, code: String(this.code).trim(), password, password_confirmation });
        } catch (error) {
            return this.notifications.serverError(error);
        }

        this.notifications.success(this.intl.t('auth.reset-password.success-message'));
        yield this.router.transitionTo('auth.login');
    }

    /**
     * Forget everything typed. Controllers outlive their page.
     *
     * @memberof AuthResetPasswordController
     */
    reset() {
        this.code = undefined;
        this.password = undefined;
        this.password_confirmation = undefined;
        this.isPasswordVisible = false;
        this.isLinkInvalid = false;
        this.hasCodeFromLink = false;
    }
}
