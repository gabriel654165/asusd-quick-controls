// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

const BUS_NAME = 'org.asuslinux.Daemon';
const OBJECT_PATH = '/org/asuslinux';
const IFACE = 'org.asuslinux.Platform';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

const CHARGE_MIN = 20;
const CHARGE_MAX = 100;
const CHARGE_STEP = 10;

const MODES = [
    {value: 0, label: 'Balanced', icon: 'power-profile-balanced-symbolic'},
    {value: 1, label: 'Performance', icon: 'power-profile-performance-symbolic'},
    {value: 2, label: 'Quiet', icon: 'power-profile-power-saver-symbolic'},
];

function logError(e) {
    console.error(`Quick Controls for asusd: ${e.message}`);
}

class Asusd {
    constructor() {
        this._conn = Gio.DBus.system;
        this._subId = 0;
    }

    _call(iface, method, params, replyType) {
        return new Promise((resolve, reject) => {
            this._conn.call(
                BUS_NAME, OBJECT_PATH, iface, method, params, replyType,
                Gio.DBusCallFlags.NONE, -1, null,
                (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async getProperty(name) {
        const reply = await this._call(PROPERTIES_IFACE, 'Get',
            new GLib.Variant('(ss)', [IFACE, name]),
            new GLib.VariantType('(v)'));
        const [value] = reply.deep_unpack();
        return value.deep_unpack();
    }

    async setProperty(name, type, value) {
        await this._call(PROPERTIES_IFACE, 'Set',
            new GLib.Variant('(ssv)', [IFACE, name, new GLib.Variant(type, value)]),
            null);
    }

    async callMethod(name) {
        await this._call(IFACE, name, null, null);
    }

    watch(callback) {
        this._subId = this._conn.signal_subscribe(
            BUS_NAME, PROPERTIES_IFACE, 'PropertiesChanged',
            OBJECT_PATH, null, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [changedIface, changed] = params.deep_unpack();
                if (changedIface !== IFACE)
                    return;
                for (const [name, value] of Object.entries(changed))
                    callback(name, value.deep_unpack());
            });
    }

    unwatch() {
        if (this._subId) {
            this._conn.signal_unsubscribe(this._subId);
            this._subId = 0;
        }
    }
}

const ChargeLimitMenuItem = GObject.registerClass(
class ChargeLimitMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(asusd) {
        super._init({activate: false, style_class: 'popup-slider-menu-item'});
        this._asusd = asusd;
        this._value = CHARGE_MAX;
        this._updating = false;
        this._timeoutId = 0;

        const icon = new St.Icon({
            icon_name: 'battery-good-symbolic',
            style_class: 'popup-menu-icon',
        });
        this.add_child(icon);

        this._slider = new Slider.Slider(0);
        this._slider.x_expand = true;
        this._slider.connect('notify::value', () => this._onSliderChanged());
        this.add_child(this._slider);

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 3.5em; text-align: right; font-feature-settings: "tnum";',
        });
        this.add_child(this._label);

        this._asusd.getProperty('ChargeControlEndThreshold')
            .then(value => this.setValue(value))
            .catch(logError);
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super.destroy();
    }

    setValue(value) {
        this._value = value;
        this._updating = true;
        this._slider.value = (value - CHARGE_MIN) / (CHARGE_MAX - CHARGE_MIN);
        this._updating = false;
        this._label.text = `${value}%`;
        this.accessible_name = `Battery charge limit ${value}%`;
    }

    _sliderPercent() {
        return CHARGE_MIN + this._slider.value * (CHARGE_MAX - CHARGE_MIN);
    }

    _snap(percent) {
        let value = Math.round(percent / CHARGE_STEP) * CHARGE_STEP;
        if (percent > this._value)
            value = Math.max(value, (Math.floor(this._value / CHARGE_STEP) + 1) * CHARGE_STEP);
        else if (percent < this._value)
            value = Math.min(value, (Math.ceil(this._value / CHARGE_STEP) - 1) * CHARGE_STEP);
        return Math.min(CHARGE_MAX, Math.max(CHARGE_MIN, value));
    }

    _onSliderChanged() {
        if (this._updating)
            return;

        this._label.text = `${Math.round(this._sliderPercent())}%`;

        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._timeoutId = 0;
            const value = this._snap(this._sliderPercent());
            this.setValue(value);
            this._asusd.setProperty('ChargeControlEndThreshold', 'y', value)
                .catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }
});

const PowerModeToggle = GObject.registerClass(
class PowerModeToggle extends QuickSettings.QuickMenuToggle {
    _init(asusd) {
        super._init({
            title: MODES[0].label,
            iconName: MODES[0].icon,
        });
        this._asusd = asusd;
        this._modeItems = new Map();

        this.menu.setHeader('utilities-system-monitor-symbolic', 'Power Mode');

        this.chargeLimitItem = new ChargeLimitMenuItem(asusd);
        this.menu.addMenuItem(this.chargeLimitItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (const mode of MODES) {
            const item = new PopupMenu.PopupMenuItem(mode.label);
            item.connect('activate', () => {
                this._asusd.setProperty('ThrottleThermalPolicy', 'u', mode.value)
                    .catch(logError);
            });
            this.menu.addMenuItem(item);
            this._modeItems.set(mode.value, item);
        }

        this.connect('clicked', () => {
            this._asusd.callMethod('NextThrottleThermalPolicy')
                .catch(logError);
        });

        this._asusd.getProperty('ThrottleThermalPolicy')
            .then(value => this.setMode(value))
            .catch(logError);
    }

    destroy() {
        this.menu.destroy();
        super.destroy();
    }

    setMode(value) {
        const mode = MODES.find(m => m.value === value) ?? MODES[0];
        this.title = mode.label;
        this.iconName = mode.icon;
        for (const [itemValue, item] of this._modeItems) {
            item.setOrnament(itemValue === mode.value
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }
    }
});

const AsusdIndicator = GObject.registerClass(
class AsusdIndicator extends QuickSettings.SystemIndicator {
    _init(asusd) {
        super._init();
        this.toggle = new PowerModeToggle(asusd);
        this.quickSettingsItems.push(this.toggle);
    }
});

export default class AsusdQuickControlsExtension extends Extension {
    enable() {
        this._asusd = new Asusd();
        this._indicator = new AsusdIndicator(this._asusd);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._asusd.watch((name, value) => {
            if (name === 'ChargeControlEndThreshold')
                this._indicator.toggle.chargeLimitItem.setValue(value);
            else if (name === 'ThrottleThermalPolicy')
                this._indicator.toggle.setMode(value);
        });
    }

    disable() {
        this._asusd.unwatch();
        this._asusd = null;

        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
