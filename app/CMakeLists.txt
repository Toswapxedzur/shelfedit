cmake_minimum_required(VERSION 3.21)
project(shelfedit LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

# Qt: Widgets for the native shell + preview surface; WebEngineWidgets hosts the
# HTML timeline/controls; WebChannel is the JS <-> C++ bridge.
find_package(Qt6 REQUIRED COMPONENTS Widgets WebEngineWidgets WebChannel)

# MLT (the video engine) via pkg-config. Homebrew ships mlt++-7.pc.
find_package(PkgConfig REQUIRED)
pkg_check_modules(MLT REQUIRED IMPORTED_TARGET mlt++-7)

add_executable(shelfedit
    src/main.cpp
    src/MltController.h
    src/MltController.cpp
    src/VideoWidget.h
    src/VideoWidget.cpp
    src/Bridge.h
    src/Bridge.cpp
    src/MainWindow.h
    src/MainWindow.cpp
)

target_link_libraries(shelfedit PRIVATE
    Qt6::Widgets
    Qt6::WebEngineWidgets
    Qt6::WebChannel
    PkgConfig::MLT
)

# Slice 2 dev convenience: point the app at the on-disk web/ folder so the HTML
# UI can be edited without a rebuild.
target_compile_definitions(shelfedit PRIVATE
    APP_WEB_DIR="${CMAKE_CURRENT_SOURCE_DIR}/web"
)
