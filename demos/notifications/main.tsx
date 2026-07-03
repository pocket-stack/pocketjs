// @title psp-ui: Notifications
import Notifications, { notificationsFrame } from "./app.tsx";
import { mount } from "psp-ui";

mount(() => <Notifications />, { beforeFrame: notificationsFrame });
