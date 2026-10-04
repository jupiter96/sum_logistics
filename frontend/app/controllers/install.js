import Controller from '@ember/controller';
import { inject as service } from '@ember/service';

export default class InstallController extends Controller {
    @service installation;

    runningLocallyDocsUrl = 'https://www.sum_logistics.io/docs/platform/quickstart/running-locally';
    cloudDocsUrl = 'https://www.sum_logistics.io/docs/platform/quickstart/deploy-in-cloud';

    get isRefreshing() {
        return this.installation.isRefreshing;
    }
}
