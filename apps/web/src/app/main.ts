import { createApp } from "vue";

import AppRoot from "./AppRoot.vue";

const mountPoint = document.querySelector("#appApp");
if (mountPoint) createApp(AppRoot).mount(mountPoint);
