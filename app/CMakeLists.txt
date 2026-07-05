cmake_minimum_required(VERSION 3.21)
project(shelfedit LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

# Qt: Widgets for Slice 1 (native window). WebEngineWidgets + WebChannel are
# added in Slice 2 when the HTML timeline UI is hosted.
find_package(Qt6 REQUIRED COMPONENTS Widgets)

# MLT (the video engine) via pkg-config. Homebrew ships mlt++-7.pc.
find_package(PkgConfig REQUIRED)
pkg_check_modules(MLT REQUIRED IMPORTED_TARGET mlt++-7)

add_executable(shelfedit
    src/main.cpp
    src/MltController.h
    src/MltController.cpp
    src/VideoWidget.h
    src/VideoWidget.cpp
    src/MainWindow.h
    src/MainWindow.cpp
)

target_link_libraries(shelfedit PRIVATE Qt6::Widgets PkgConfig::MLT)
