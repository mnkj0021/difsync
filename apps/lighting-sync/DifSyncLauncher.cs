using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string appDir = Path.Combine(root, "clients", "desktop-electron");
        string electron = Path.Combine(appDir, "node_modules", "electron", "dist", "electron.exe");

        if (!File.Exists(electron))
        {
            MessageBox.Show(
                "DifSync Electron runtime is missing. Run clients\\RunDesktopClient.bat once to repair it.",
                "DifSync",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = electron,
                Arguments = "\"" + appDir + "\"",
                WorkingDirectory = appDir,
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "DifSync could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
