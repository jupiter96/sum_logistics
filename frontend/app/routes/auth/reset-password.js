import Route from '@ember/routing/route';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import removeBootLoader from '../../utils/remove-boot-loader';

export default class AuthResetPasswordRoute extends Route {
    @service store;
    @service fetch;

    @action activate() {
        removeBootLoader();
    }

    async model({ id }) {
        // `for`: without it, a link id issued for anything else would count as valid here.
        return this.fetch.get('auth/validate-verification', { id, for: 'password_reset' });
    }

    async setupController(controller, model) {
        super.setupController(...arguments);

        controller.isLinkInvalid = model.is_valid === false;
        controller.hasCodeFromLink = Boolean(controller.code);

        if (controller.isLinkInvalid) {
            return;
        }

        // set brand to controller
        controller.brand = await this.store.findRecord('brand', 1);
    }

    resetController(controller, isExiting) {
        if (isExiting) {
            controller.reset();
        }
    }
}
