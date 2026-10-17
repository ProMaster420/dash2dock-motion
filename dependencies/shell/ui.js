export * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
export * as AppMenu from 'resource:///org/gnome/shell/ui/appMenu.js';
export * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
export * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
export * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
export * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
export * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
export * as Main from 'resource:///org/gnome/shell/ui/main.js';
export * as Overview from 'resource:///org/gnome/shell/ui/overview.js';
export * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
export * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
export * as SearchController from 'resource:///org/gnome/shell/ui/searchController.js';
export * as ShellMountOperation from 'resource:///org/gnome/shell/ui/shellMountOperation.js';
export * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
export * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
export * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
export * as WorkspacesView from 'resource:///org/gnome/shell/ui/workspacesView.js';
import GLib from 'gi://GLib';

class MockPointerWatcher {
    addWatch(interval, callback) {
        const tracker = global.backend.get_cursor_tracker();
        let [lastX, lastY] = tracker.get_pointer();
        const watch = {
            _id: 0,
            remove: () => this._removeWatch(watch),
        };
        watch._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(interval, 16), () => {
            const [x, y] = tracker.get_pointer();
            if (x !== lastX || y !== lastY) {
                lastX = x;
                lastY = y;
                callback(x, y);
            }
            return GLib.SOURCE_CONTINUE;
        });
        return watch;
    }
    _removeWatch(watch) {
        if (watch?._id) {
            GLib.source_remove(watch._id);
            watch._id = 0;
        }
    }
}

let _mockInstance = null;
export const PointerWatcher = {
    getPointerWatcher: () => {
        if (!_mockInstance) _mockInstance = new MockPointerWatcher();
        return _mockInstance;
    }
};
