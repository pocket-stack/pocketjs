// @title Pocket YouTube
import App from "./app.tsx";
import { installYoutubeDriver } from "./driver.ts";
import { mount } from "@pocketjs/framework";

installYoutubeDriver();
mount(() => <App />);
