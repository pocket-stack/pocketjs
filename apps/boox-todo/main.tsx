// @title Pocket Todo
import { mount } from "@pocketjs/framework";
import Clear from "../clear/app.tsx";
import { makeList } from "../clear/model.ts";
import { CLEAR_EINK_PALETTE } from "../clear/palette.ts";

function seedTodoLists() {
  return [
    makeList("Inbox", [
      "Tap a row to edit",
      "Pull down to add a task",
      "Swipe right when finished",
      "Swipe left to delete",
    ]),
    makeList("Today", [
      "Read for 20 minutes",
      "Plan tomorrow",
    ]),
    makeList("Later", []),
  ];
}

mount(() => <Clear palette={CLEAR_EINK_PALETTE} seed={seedTodoLists} />);
