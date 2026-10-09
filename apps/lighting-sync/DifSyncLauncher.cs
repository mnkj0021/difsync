using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("DifSync")]
[assembly: AssemblyDescription("DifSync Lighting Studio")]
[assembly: AssemblyProduct("DifSync")]
[assembly: AssemblyCompany("DifSync")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string appDir = Path.Combine(root, "clients", "desktop-electron");
        string electron = Path.Combine(appDir, "node_modules", "electron", "dist", "electron.exe");
        if (!File.Exists(electron))
        {
            MessageBox.Show(
                "DifSync Electron runtime is missing. Repair the desktop runtime in G:\\DifSync\\clients\\desktop-electron.",
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
