import Route from '@ember/routing/route';
import { action } from '@ember/object';
import removeBootLoader from '../../utils/remove-boot-loader';

export default class AuthForgotPasswordRoute extends Route {
    queryParams = {
        email: {
            refreshModel: false,
        },
    };

    @action activate() {
        removeBootLoader();
    }

    resetController(controller, isExiting) {
        if (isExiting) {
            controller.reset();
        }
    }
}
