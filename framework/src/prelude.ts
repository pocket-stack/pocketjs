// Runtime globals that must exist before Vue Vapor scheduler modules evaluate.

import "./scheduler-polyfill.ts";
import { installVueVaporDom } from "./vue-vapor-dom.ts";

installVueVaporDom();
