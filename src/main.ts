import { mount } from "svelte";
import App from "./App.svelte";
import { Controller } from "./controller.svelte";
import "./app.css";

const controller = new Controller();
mount(App, { target: document.getElementById("app")!, props: { c: controller } });
void controller.start();
