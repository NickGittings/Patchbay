//! Native commands share frontend actions; standard application/Edit/Window behavior stays native.
use serde::Deserialize;
use tauri::{AppHandle, WebviewWindow};

#[derive(Clone, Deserialize)]
pub(crate) struct Entry {
    id: String,
    title: String,
    group: String,
    enabled: bool,
}

#[cfg(target_os = "macos")]
pub(crate) fn install(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, Submenu};
    let menu = Menu::default(app)?;
    // Replace the default File menu, preserving the application, Edit, View and Window menus.
    menu.remove_at(1)?;
    menu.insert(&Submenu::with_id(app, "project", "Project", true)?, 1)?;
    menu.insert(&Submenu::with_id(app, "settings", "Settings", true)?, 2)?;
    app.set_menu(menu)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn update_native_menu(
    window: WebviewWindow,
    app: AppHandle,
    entries: Vec<Entry>,
) -> Result<(), String> {
    super::main_only(&window)?;
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::MenuItem;
        let menu = app.menu().ok_or("Native menu is unavailable")?;
        for group in ["project", "settings"] {
            let item = menu.get(group).ok_or("Native submenu is unavailable")?;
            let submenu = item.as_submenu().ok_or("Expected native submenu")?;
            while submenu.remove_at(0).map_err(super::err)?.is_some() {}
            for entry in entries.iter().filter(|entry| entry.group == group) {
                // Cmd+S is owned here only; JS handles search and view shortcuts in each window.
                let accelerator = (entry.id == "action:save").then_some("CmdOrCtrl+S");
                let item = MenuItem::with_id(
                    &app,
                    format!("patchbay:{}", entry.id),
                    &entry.title,
                    entry.enabled,
                    accelerator,
                )
                .map_err(super::err)?;
                submenu.append(&item).map_err(super::err)?;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        for entry in entries {
            let _ = (entry.id, entry.title, entry.group, entry.enabled);
        }
    }
    Ok(())
}

/// Read the actual native items for desktop smoke checks; unavailable in release builds.
#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn inspect_native_menu(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<Vec<(String, String, bool)>, String> {
    super::main_only(&window)?;
    #[cfg(target_os = "macos")]
    {
        let menu = app.menu().ok_or("Native menu is unavailable")?;
        let mut entries = Vec::new();
        for item in menu.items().map_err(super::err)? {
            if let Some(submenu) = item.as_submenu() {
                entries.push((
                    submenu.id().0.clone(),
                    submenu.text().map_err(super::err)?,
                    true,
                ));
                for child in submenu.items().map_err(super::err)? {
                    if let Some(command) = child.as_menuitem() {
                        entries.push((
                            command.id().0.clone(),
                            command.text().map_err(super::err)?,
                            command.is_enabled().map_err(super::err)?,
                        ));
                    }
                }
            }
        }
        Ok(entries)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Native menu inspection requires a macOS debug build".into())
    }
}
